// macOS ScreenCaptureKit helper.
//
// Protocol:
//   stdin   : NDJSON Request (Start | Stop | Shutdown)
//   stdout  : NDJSON Event   (ready | started | stopped | audio | frame | error | log)
//   stderr  : free-form diagnostic text (mirrored by the parent as warn logs)
//
// Single SCStream multiplexes Screen + Audio. Frames are JPEG/PNG encoded in
// the handler thread; audio is converted to interleaved s16le mono and shipped
// at whatever sample rate ScreenCaptureKit actually delivers (the parent
// resamples / chunks).

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use hpm_util::{emit, now_ms, SharedOut};
use image::{codecs::jpeg::JpegEncoder, codecs::png::PngEncoder, ColorType, ImageEncoder};
use screencapturekit::cm::CMSampleBufferExt;
use screencapturekit::cv::CVPixelBufferLockFlags;
use screencapturekit::prelude::*;
use serde::Deserialize;
use serde_json::json;
use std::io::{self, BufRead};
use std::sync::{Arc, Mutex};

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Request {
    Start(StartParams),
    Stop,
    Shutdown,
}

#[derive(Deserialize, Default)]
struct StartParams {
    #[serde(default)]
    capture_audio: Option<bool>,
    #[serde(default)]
    capture_video: Option<bool>,
    #[serde(default)]
    sample_rate: Option<u32>,
    #[serde(default)]
    channel_count: Option<u32>,
    #[serde(default)]
    frame_interval_ms: Option<u32>,
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default)]
    image_format: Option<String>, // "png" | "jpeg"
    #[serde(default)]
    jpeg_quality: Option<u8>,
}

#[derive(Clone)]
struct ImageOpts {
    format: ImageFormat,
    jpeg_quality: u8,
}

#[derive(Clone, Copy)]
enum ImageFormat {
    Png,
    Jpeg,
}

impl ImageFormat {
    fn parse(value: Option<&str>) -> Self {
        match value.map(str::to_ascii_lowercase).as_deref() {
            Some("jpeg") | Some("jpg") => ImageFormat::Jpeg,
            _ => ImageFormat::Png,
        }
    }
}

struct Handler {
    out: SharedOut,
    image: ImageOpts,
    audio_sample_rate: u32,
    audio_channels: u32,
}

impl SCStreamOutputTrait for Handler {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, of_type: SCStreamOutputType) {
        let res = match of_type {
            SCStreamOutputType::Screen => self.handle_screen(&sample),
            SCStreamOutputType::Audio => self.handle_audio(&sample),
            _ => Ok(()),
        };
        if let Err(err) = res {
            emit(
                &self.out,
                json!({"type": "error", "at": now_ms(), "message": err.to_string()}),
            );
        }
    }
}

impl Handler {
    fn handle_screen(&self, sample: &CMSampleBuffer) -> Result<()> {
        let Some(pixel_buffer) = sample.image_buffer() else {
            return Ok(());
        };
        let guard = pixel_buffer
            .lock(CVPixelBufferLockFlags::READ_ONLY)
            .map_err(|e| anyhow!("CVPixelBuffer lock failed: {e:?}"))?;
        let width = guard.width() as u32;
        let height = guard.height() as u32;
        let bytes_per_row = guard.bytes_per_row() as usize;
        let src = guard.as_slice();

        // BGRA8 → RGBA8 with row-stride awareness.
        let mut rgba = vec![0u8; (width as usize) * (height as usize) * 4];
        let row_bytes = (width as usize) * 4;
        for y in 0..(height as usize) {
            let src_row = &src[y * bytes_per_row..y * bytes_per_row + row_bytes];
            let dst_row = &mut rgba[y * row_bytes..(y + 1) * row_bytes];
            for (s, d) in src_row.chunks_exact(4).zip(dst_row.chunks_exact_mut(4)) {
                d[0] = s[2];
                d[1] = s[1];
                d[2] = s[0];
                d[3] = s[3];
            }
        }
        drop(guard);

        let mut encoded = Vec::with_capacity(rgba.len() / 4);
        let (fmt_label, mime) = match self.image.format {
            ImageFormat::Png => {
                PngEncoder::new(&mut encoded)
                    .write_image(&rgba, width, height, ColorType::Rgba8.into())
                    .context("png encode")?;
                ("png", "image/png")
            }
            ImageFormat::Jpeg => {
                // JPEG has no alpha; drop A channel.
                let mut rgb = Vec::with_capacity((width as usize) * (height as usize) * 3);
                for px in rgba.chunks_exact(4) {
                    rgb.extend_from_slice(&px[..3]);
                }
                JpegEncoder::new_with_quality(&mut encoded, self.image.jpeg_quality)
                    .write_image(&rgb, width, height, ColorType::Rgb8.into())
                    .context("jpeg encode")?;
                ("jpeg", "image/jpeg")
            }
        };

        emit(
            &self.out,
            json!({
                "type": "frame",
                "at": now_ms(),
                "width": width,
                "height": height,
                "format": fmt_label,
                "mime": mime,
                "image_b64": BASE64.encode(&encoded),
            }),
        );
        Ok(())
    }

    fn handle_audio(&self, sample: &CMSampleBuffer) -> Result<()> {
        let Some(list) = sample.audio_buffer_list() else {
            return Ok(());
        };
        // ScreenCaptureKit delivers Float32 little-endian, one AudioBuffer per
        // channel (non-interleaved). Mix down to mono s16. We copy per-channel
        // bytes upfront since AudioBuffer borrows can't outlive each loop iter.
        let mut channels: Vec<Vec<u8>> = Vec::new();
        for i in 0..list.num_buffers() {
            if let Some(buf) = list.buffer(i) {
                channels.push(buf.data().to_vec());
            }
        }
        if channels.is_empty() {
            return Ok(());
        }
        let frames = channels[0].len() / 4;
        let mut pcm = Vec::with_capacity(frames * 2);
        for f in 0..frames {
            let mut acc = 0f32;
            let mut active = 0u32;
            for ch in &channels {
                if ch.len() < (f + 1) * 4 {
                    continue;
                }
                let bytes = &ch[f * 4..f * 4 + 4];
                acc += f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
                active += 1;
            }
            let mixed = if active > 0 { acc / active as f32 } else { 0.0 };
            let clamped = mixed.clamp(-1.0, 1.0);
            let s = (clamped * i16::MAX as f32) as i16;
            pcm.extend_from_slice(&s.to_le_bytes());
        }

        emit(
            &self.out,
            json!({
                "type": "audio",
                "at": now_ms(),
                "sample_rate": self.audio_sample_rate,
                "channels": 1u32,
                "source_channels": self.audio_channels,
                "pcm_b64": BASE64.encode(&pcm),
            }),
        );
        Ok(())
    }
}

pub fn run() -> Result<()> {
    let stdin = io::stdin();
    let out: SharedOut = Arc::new(Mutex::new(io::stdout()));

    emit(&out, json!({"type": "ready", "engine": "sck"}));

    let mut stream: Option<SCStream> = None;
    let mut started_params: Option<StartParams> = None;

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(err) => {
                emit(
                    &out,
                    json!({"type": "error", "at": now_ms(), "message": format!("stdin read: {err}")}),
                );
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(err) => {
                emit(
                    &out,
                    json!({"type": "error", "at": now_ms(), "message": format!("bad request: {err}")}),
                );
                continue;
            }
        };

        match req {
            Request::Start(params) => {
                if stream.is_some() {
                    emit(
                        &out,
                        json!({"type": "log", "at": now_ms(), "level": "warn", "message": "already running"}),
                    );
                    continue;
                }
                match start_capture(&out, &params) {
                    Ok(s) => {
                        emit(
                            &out,
                            json!({
                                "type": "started",
                                "at": now_ms(),
                                "sample_rate": params.sample_rate.unwrap_or(48_000),
                                "frame_interval_ms": params.frame_interval_ms.unwrap_or(5_000),
                            }),
                        );
                        stream = Some(s);
                        started_params = Some(params);
                    }
                    Err(err) => {
                        emit(
                            &out,
                            json!({"type": "error", "at": now_ms(), "message": format!("start failed: {err:#}")}),
                        );
                    }
                }
            }
            Request::Stop => {
                if let Some(s) = stream.take() {
                    if let Err(err) = s.stop_capture() {
                        emit(
                            &out,
                            json!({"type": "error", "at": now_ms(), "message": format!("stop failed: {err:?}")}),
                        );
                    }
                    started_params = None;
                    emit(&out, json!({"type": "stopped", "at": now_ms()}));
                }
            }
            Request::Shutdown => {
                if let Some(s) = stream.take() {
                    let _ = s.stop_capture();
                }
                break;
            }
        }
    }

    let _ = started_params; // silence unused warning if logic shrinks
    Ok(())
}

fn start_capture(out: &SharedOut, params: &StartParams) -> Result<SCStream> {
    let content = SCShareableContent::get().map_err(|e| anyhow!("shareable content: {e:?}"))?;
    let display = content
        .displays()
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("no display found"))?;

    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&[])
        .build();

    let want_audio = params.capture_audio.unwrap_or(true);
    let want_video = params.capture_video.unwrap_or(true);
    let sample_rate = params.sample_rate.unwrap_or(48_000);
    let channel_count = params.channel_count.unwrap_or(2);
    let width = params.width.unwrap_or(1920);
    let height = params.height.unwrap_or(1080);

    let mut cfg = SCStreamConfiguration::new()
        .with_width(width)
        .with_height(height)
        .with_pixel_format(PixelFormat::BGRA);

    if want_audio {
        cfg = cfg
            .with_captures_audio(true)
            .with_sample_rate(sample_rate as i32)
            .with_channel_count(channel_count as i32);
    }

    let mut stream = SCStream::new(&filter, &cfg);

    let image_opts = ImageOpts {
        format: ImageFormat::parse(params.image_format.as_deref()),
        jpeg_quality: params.jpeg_quality.unwrap_or(80).clamp(1, 100),
    };

    if want_video {
        stream.add_output_handler(
            Handler {
                out: out.clone(),
                image: image_opts.clone(),
                audio_sample_rate: sample_rate,
                audio_channels: channel_count,
            },
            SCStreamOutputType::Screen,
        );
    }
    if want_audio {
        stream.add_output_handler(
            Handler {
                out: out.clone(),
                image: image_opts,
                audio_sample_rate: sample_rate,
                audio_channels: channel_count,
            },
            SCStreamOutputType::Audio,
        );
    }

    stream
        .start_capture()
        .map_err(|e| anyhow!("start_capture: {e:?}"))?;
    Ok(stream)
}

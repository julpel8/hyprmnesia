// Windows WASAPI loopback capture.
//
// Captures the default (or named) render endpoint via a shared-mode loopback
// stream. The WASAPI calls follow the wasapi-rs loopback example: opening a
// *render* device with `Direction::Capture` enables the loopback flag, which
// taps the engine mix and keeps producing audio even when the audible endpoint
// is muted or its volume is zero.
//
// The endpoint mix format is typically 32-bit float, stereo, 44.1/48 kHz. We
// downmix to mono and resample to the requested rate (default 16 kHz) with a
// small box-averaging + linear-interpolation resampler — adequate for speech
// ASR and dependency-free — then emit s16le bytes to stdout, matching the PCM
// stream the TypeScript pipeline reads from ffmpeg.

use std::collections::VecDeque;
use std::io::{self, Write};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use wasapi::{get_default_device, Direction, SampleType, StreamMode};

const DEFAULT_RATE: u32 = 16_000;
const EVENT_WAIT_MS: u32 = 2_000;
const SILENCE_GAP_TOLERANCE_MS: u64 = 100;

struct Args {
    rate: u32,
    device: Option<String>,
}

fn parse_args() -> Result<Args> {
    let mut rate = DEFAULT_RATE;
    let mut device = None;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--rate" => {
                let v = it.next().context("--rate requires a value")?;
                rate = v.parse().with_context(|| format!("invalid --rate: {v}"))?;
            }
            "--device" => {
                device = Some(it.next().context("--device requires a value")?);
            }
            other => return Err(anyhow!("unknown argument: {other}")),
        }
    }
    if rate == 0 {
        return Err(anyhow!("--rate must be greater than zero"));
    }
    Ok(Args { rate, device })
}

fn pick_device(name: &Option<String>) -> Result<wasapi::Device> {
    if let Some(want) = name {
        let collection = wasapi::DeviceCollection::new(&Direction::Render)
            .map_err(|e| anyhow!("enumerate render devices: {e}"))?;
        let count = collection
            .get_nbr_devices()
            .map_err(|e| anyhow!("count render devices: {e}"))?;
        for i in 0..count {
            let dev = collection
                .get_device_at_index(i)
                .map_err(|e| anyhow!("open render device {i}: {e}"))?;
            if let Ok(friendly) = dev.get_friendlyname() {
                if friendly.eq_ignore_ascii_case(want) {
                    return Ok(dev);
                }
            }
        }
        return Err(anyhow!("render device '{want}' not found"));
    }
    get_default_device(&Direction::Render).map_err(|e| anyhow!("default render device: {e}"))
}

// Mono linear-interpolation resampler that keeps fractional position across
// packets, so packet boundaries don't introduce clicks. For downsampling it
// also box-averages the source samples spanned by each output step, which
// gives basic anti-aliasing (e.g. 48k -> 16k).
struct Resampler {
    ratio: f64, // src samples per output sample
    pos: f64,
    last: f32,
    history: Vec<f32>,
}

impl Resampler {
    fn new(src_rate: u32, dst_rate: u32) -> Self {
        Self {
            ratio: src_rate as f64 / dst_rate as f64,
            pos: 0.0,
            last: 0.0,
            history: Vec::new(),
        }
    }

    fn push(&mut self, src: &[f32], out: &mut Vec<i16>) {
        if src.is_empty() {
            return;
        }
        // Carry one previous sample so interpolation can reach back across the
        // packet boundary.
        self.history.clear();
        self.history.push(self.last);
        self.history.extend_from_slice(src);
        let samples = &self.history;
        // `pos` is indexed against `src`; offset by 1 for the carried sample.
        if self.ratio > 1.0 {
            // Downsampling: box-average across the step.
            while self.pos < src.len() as f64 {
                let end = (self.pos + self.ratio).min(src.len() as f64);
                let mut acc = 0.0f32;
                let mut n = 0u32;
                let mut k = self.pos.floor() as usize;
                while (k as f64) < end {
                    acc += samples[k + 1];
                    n += 1;
                    k += 1;
                }
                // n >= 1: pos.floor() < end because end > pos.
                out.push(to_i16(acc / n as f32));
                self.pos += self.ratio;
            }
        } else {
            // Upsampling or same-rate: linear interpolation.
            while self.pos < src.len() as f64 {
                let lo = self.pos.floor();
                let i = lo as usize + 1;
                let a = samples[i - 1];
                let b = samples[i];
                out.push(to_i16(a + (b - a) * (self.pos - lo) as f32));
                self.pos += self.ratio;
            }
        }
        self.pos -= src.len() as f64;
        self.last = src[src.len() - 1];
    }
}

fn to_i16(sample: f32) -> i16 {
    let clamped = sample.clamp(-1.0, 1.0);
    (clamped * i16::MAX as f32) as i16
}

fn duration_to_samples(duration: Duration, sample_rate: u32) -> usize {
    let samples = duration.as_nanos().saturating_mul(sample_rate as u128) / 1_000_000_000u128;
    samples.min(usize::MAX as u128) as usize
}

fn samples_to_duration(samples: usize, sample_rate: u32) -> Duration {
    Duration::from_secs_f64(samples as f64 / sample_rate as f64)
}

fn write_silence<W: Write>(writer: &mut W, samples: usize) -> Result<()> {
    let mut remaining = samples.saturating_mul(2);
    let zeros = [0u8; 8192];
    while remaining > 0 {
        let take = remaining.min(zeros.len());
        writer
            .write_all(&zeros[..take])
            .context("write silent PCM to stdout (downstream closed?)")?;
        remaining -= take;
    }
    writer.flush().ok();
    Ok(())
}

// Decode one interleaved frame block (bytes) into mono f32 samples.
fn decode_mono(
    bytes: &[u8],
    channels: usize,
    bytes_per_sample: usize,
    is_float: bool,
    out: &mut Vec<f32>,
) {
    let frame_bytes = channels * bytes_per_sample;
    if frame_bytes == 0 {
        return;
    }
    for frame in bytes.chunks_exact(frame_bytes) {
        let mut sum = 0.0f32;
        for ch in 0..channels {
            let s = &frame[ch * bytes_per_sample..(ch + 1) * bytes_per_sample];
            sum += sample_to_f32(s, is_float);
        }
        out.push(sum / channels as f32);
    }
}

fn sample_to_f32(bytes: &[u8], is_float: bool) -> f32 {
    if is_float && bytes.len() == 4 {
        return f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    }
    match bytes.len() {
        2 => i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / i16::MAX as f32,
        4 => i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32 / i32::MAX as f32,
        3 => {
            let v = (bytes[0] as i32) | ((bytes[1] as i32) << 8) | ((bytes[2] as i32) << 16);
            let v = (v << 8) >> 8; // sign-extend 24-bit
            v as f32 / 8_388_607.0
        }
        _ => 0.0,
    }
}

pub fn run() -> Result<()> {
    let args = parse_args()?;

    wasapi::initialize_mta()
        .ok()
        .map_err(|e| anyhow!("initialize COM (MTA): {e}"))?;

    let device = pick_device(&args.device)?;

    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|e| anyhow!("get audio client: {e}"))?;
    let format = audio_client
        .get_mixformat()
        .map_err(|e| anyhow!("get mix format: {e}"))?;

    let channels = format.get_nchannels() as usize;
    let src_rate = format.get_samplespersec();
    let bits = format.get_bitspersample() as usize;
    let bytes_per_sample = bits / 8;
    let is_float = matches!(
        format
            .get_subformat()
            .map_err(|e| anyhow!("get sample subformat: {e}"))?,
        SampleType::Float
    );
    let block_align = format.get_blockalign() as usize;

    let (default_period, _min_period) = audio_client
        .get_device_period()
        .map_err(|e| anyhow!("get device period: {e}"))?;
    // Opening a Render device with Direction::Capture in shared mode makes
    // wasapi-rs set AUDCLNT_STREAMFLAGS_LOOPBACK. We keep the engine mix format
    // (autoconvert off) and do our own downmix/resample.
    audio_client
        .initialize_client(
            &format,
            &Direction::Capture,
            &StreamMode::EventsShared {
                autoconvert: false,
                buffer_duration_hns: default_period,
            },
        )
        .map_err(|e| anyhow!("initialize loopback client: {e}"))?;

    let event = audio_client
        .set_get_eventhandle()
        .map_err(|e| anyhow!("set event handle: {e}"))?;
    let capture = audio_client
        .get_audiocaptureclient()
        .map_err(|e| anyhow!("get capture client: {e}"))?;

    // Keep stderr quiet on the happy path: the parent treats any stderr output
    // on a non-zero exit as an error, and logs the selected backend/device from
    // the `started` event instead. Only real failures (propagated as Err) reach
    // stderr.
    audio_client
        .start_stream()
        .map_err(|e| anyhow!("start loopback stream: {e}"))?;

    let mut resampler = Resampler::new(src_rate, args.rate);
    let mut queue: VecDeque<u8> = VecDeque::new();
    let mut mono: Vec<f32> = Vec::new();
    let mut out: Vec<i16> = Vec::new();
    let stdout = io::stdout();
    let mut writer = io::BufWriter::new(stdout.lock());
    let mut emitted_until = Instant::now();

    loop {
        // Shared-mode loopback only produces packets while something is being
        // rendered. During system silence WASAPI does not signal the event, but
        // the TypeScript pipeline still needs continuous PCM so chunk_ms stays
        // wall-clock bounded.
        if event.wait_for_event(EVENT_WAIT_MS).is_err() {
            let now = Instant::now();
            write_silence(
                &mut writer,
                duration_to_samples(now.duration_since(emitted_until), args.rate),
            )?;
            emitted_until = now;
            continue;
        }

        capture
            .read_from_device_to_deque(&mut queue)
            .map_err(|e| anyhow!("read loopback packet: {e}"))?;

        // Drain whole frames; keep any trailing partial frame for next read.
        let usable = (queue.len() / block_align) * block_align;
        if usable == 0 {
            let now = Instant::now();
            write_silence(
                &mut writer,
                duration_to_samples(now.duration_since(emitted_until), args.rate),
            )?;
            emitted_until = now;
            continue;
        }
        let bytes: Vec<u8> = queue.drain(..usable).collect();
        mono.clear();
        decode_mono(&bytes, channels, bytes_per_sample, is_float, &mut mono);
        out.clear();
        resampler.push(&mono, &mut out);
        if out.is_empty() {
            let now = Instant::now();
            write_silence(
                &mut writer,
                duration_to_samples(now.duration_since(emitted_until), args.rate),
            )?;
            emitted_until = now;
            continue;
        }
        let now = Instant::now();
        let elapsed = now.duration_since(emitted_until);
        let packet_duration = samples_to_duration(out.len(), args.rate);
        let tolerance = Duration::from_millis(SILENCE_GAP_TOLERANCE_MS);
        if elapsed > packet_duration + tolerance {
            write_silence(
                &mut writer,
                duration_to_samples(elapsed - packet_duration, args.rate),
            )?;
        }
        let raw: &[u8] = i16_le_bytes(&out);
        writer
            .write_all(raw)
            .context("write PCM to stdout (downstream closed?)")?;
        // Flush each packet so the parent's reader gets audio at capture latency
        // (~10 ms) rather than waiting for the BufWriter to fill.
        writer.flush().ok();
        emitted_until = now;
    }
}

// Reinterpret i16 samples as little-endian bytes without an extra dependency.
// Safe on little-endian targets (all supported Windows arches); WASAPI itself
// only runs on little-endian Windows.
fn i16_le_bytes(samples: &[i16]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(samples.as_ptr() as *const u8, samples.len() * 2) }
}

#[cfg(test)]
mod tests {
    //! Resampler unit tests. The resampler is the only piece of win.rs that
    //! doesn't touch the WASAPI COM layer, so it's the bit we can exercise
    //! without a real audio endpoint.
    //!
    //! These tests synthesize known signals (DC, ramps, sine waves) at a
    //! source rate, push them through `Resampler::push`, and check the output
    //! length, magnitudes, and that splitting a signal across packet
    //! boundaries produces the same result as a single push.
    use super::{to_i16, Resampler};
    use std::assert;
    use std::assert_eq;
    use std::f32::consts::PI;
    use std::f64::consts::PI as PI64;
    use std::i16;
    use std::iter::Iterator;
    use std::vec;
    use std::vec::Vec;

    fn drain(resampler: &mut Resampler, src: &[f32]) -> Vec<i16> {
        let mut out = Vec::new();
        resampler.push(src, &mut out);
        out
    }

    fn dc(value: f32, n: usize) -> Vec<f32> {
        vec![value; n]
    }

    fn sine(freq_hz: f64, sample_rate: u32, n: usize, amplitude: f32) -> Vec<f32> {
        (0..n)
            .map(|i| {
                let t = i as f64 / sample_rate as f64;
                (amplitude as f64 * (2.0 * PI64 * freq_hz * t).sin()) as f32
            })
            .collect()
    }

    fn ramp(n: usize, amplitude: f32) -> Vec<f32> {
        (0..n)
            .map(|i| amplitude * (i as f32) / ((n.max(1) - 1).max(1) as f32))
            .collect()
    }

    #[test]
    fn empty_src_is_a_no_op_and_does_not_panic() {
        let mut r = Resampler::new(48_000, 16_000);
        let mut out = vec![i16::MIN, i16::MAX]; // sentinel; should not be touched.
        r.push(&[], &mut out);
        assert_eq!(
            out,
            vec![i16::MIN, i16::MAX],
            "out buffer must be untouched"
        );
    }

    #[test]
    fn same_rate_is_a_near_identity_modulo_i16_quantization() {
        // ratio = 1.0 takes the linear-interpolation branch. The resampler
        // carries one previous sample (initially 0) for cross-packet interp,
        // so output[N] corresponds to the *interpolation between last and
        // src[N]*. At ratio=1.0 that's exactly src[N-1] (with src[-1]=last).
        // We push twice so by the second push `last` is primed and the output
        // is a clean one-sample-lagged copy of the input.
        let mut r = Resampler::new(16_000, 16_000);
        let warmup = vec![0.5_f32; 4];
        let mut _scratch = Vec::new();
        r.push(&warmup, &mut _scratch);

        let src = vec![-0.5_f32, -0.25, 0.0, 0.25, 0.5, 0.75, -0.75, -1.0];
        let out = drain(&mut r, &src);
        assert_eq!(out.len(), src.len(), "same-rate should preserve length");
        // out[0] is interpolated from last (= 0.5 after warmup, the previous
        // src's final value) against src[0]; at ratio=1 the fractional part is
        // 0 so out[0] == to_i16(last) == to_i16(0.5).
        let want_first = to_i16(0.5);
        assert!(
            (out[0] as i32 - want_first as i32).abs() <= 1,
            "out[0] should equal previous last sample: got {} want {}",
            out[0],
            want_first
        );
        // Then out[i] (i>=1) corresponds to src[i-1]: a clean lag of one.
        for i in 1..out.len() {
            let want = to_i16(src[i - 1]);
            assert!(
                (out[i] as i32 - want as i32).abs() <= 1,
                "sample {i}: got {}, want {} (src[{}]={})",
                out[i],
                want,
                i - 1,
                src[i - 1]
            );
        }
    }

    fn warmup(r: &mut Resampler, value: f32) {
        // Push a primer packet so `last` matches the steady-state value before
        // the assertion phase. Avoids the one-sample interpolation-from-zero
        // artifact on the very first push.
        let mut _scratch = Vec::new();
        r.push(&dc(value, 64), &mut _scratch);
    }

    #[test]
    fn dc_signal_in_yields_dc_signal_out_at_same_magnitude() {
        // A DC level should be unchanged by both the linear-interp and the
        // box-average paths: averages of constants are the constant. We warm
        // up first because the resampler carries one previous sample
        // (initially 0) for cross-packet interpolation, which biases the very
        // first sample of the very first push toward zero.
        for &(src_rate, dst_rate) in &[
            (16_000_u32, 16_000_u32), // same-rate
            (16_000, 32_000),         // upsample
            (48_000, 16_000),         // downsample
        ] {
            let mut r = Resampler::new(src_rate, dst_rate);
            warmup(&mut r, 0.42);
            let src = dc(0.42, 480);
            let out = drain(&mut r, &src);
            let want = to_i16(0.42);
            assert!(!out.is_empty(), "{src_rate}->{dst_rate}: empty output");
            for (i, &s) in out.iter().enumerate() {
                assert!(
                    (s as i32 - want as i32).abs() <= 1,
                    "{src_rate}->{dst_rate} sample {i}: got {s}, want {want}"
                );
            }
        }
    }

    #[test]
    fn upsampling_doubles_output_length_within_one_sample() {
        // ratio = src/dst = 0.5; src.len() / 0.5 = 2 * src.len() output samples
        // (plus or minus a sample at the boundary depending on the carried pos).
        let mut r = Resampler::new(16_000, 32_000);
        let src = sine(440.0, 16_000, 320, 0.5);
        let out = drain(&mut r, &src);
        let expected = src.len() * 2;
        let diff = (out.len() as isize - expected as isize).abs();
        assert!(
            diff <= 1,
            "upsampled length {} not within 1 of expected {}",
            out.len(),
            expected
        );
    }

    #[test]
    fn upsampling_linear_interpolation_midpoint_is_average_of_neighbors() {
        // ratio = 0.5 means we step pos by 0.5, so every output sample is at
        // either an integer position (= source sample) or a half-step (=
        // midpoint of two source samples).
        //
        // The implementation also carries one previous sample (`last`,
        // initially 0) at history[0], so position N is interpolated between
        // src[N-1] (or `last` for N=0) and src[N]. We trace the math out
        // below for the first push (last = 0).
        let mut r = Resampler::new(1, 2); // ratio = 0.5
        let src = vec![0.0_f32, 1.0, 0.0, -1.0];
        let out = drain(&mut r, &src);
        // First push: history = [last=0, 0, 1, 0, -1].
        // pos=0.0 -> a=h[0]=0, b=h[1]=0  -> 0
        // pos=0.5 -> a=h[0]=0, b=h[1]=0  -> 0
        // pos=1.0 -> a=h[1]=0, b=h[2]=1  -> 0
        // pos=1.5 -> a=h[1]=0, b=h[2]=1  -> 0.5
        // pos=2.0 -> a=h[2]=1, b=h[3]=0  -> 1
        // pos=2.5 -> a=h[2]=1, b=h[3]=0  -> 0.5
        // pos=3.0 -> a=h[3]=0, b=h[4]=-1 -> 0
        // pos=3.5 -> a=h[3]=0, b=h[4]=-1 -> -0.5
        assert_eq!(out.len(), 8, "expected 8 samples for 4 src @ 1:2");
        let expected_f = [0.0, 0.0, 0.0, 0.5, 1.0, 0.5, 0.0, -0.5];
        for (i, &want_f) in expected_f.iter().enumerate() {
            let want = to_i16(want_f);
            let got = out[i];
            assert!(
                (got as i32 - want as i32).abs() <= 1,
                "interpolated sample {i}: got {got}, want {want} ({want_f})"
            );
        }
    }

    #[test]
    fn downsampling_halves_output_length_within_one_sample() {
        // ratio = src/dst = 3.0; src.len() / 3 output samples (± 1).
        let mut r = Resampler::new(48_000, 16_000);
        let src = sine(440.0, 48_000, 960, 0.5);
        let out = drain(&mut r, &src);
        let expected = src.len() / 3;
        let diff = (out.len() as isize - expected as isize).abs();
        assert!(
            diff <= 1,
            "downsampled length {} not within 1 of expected {}",
            out.len(),
            expected
        );
    }

    #[test]
    fn downsampling_box_averages_reduce_high_frequency_content() {
        // Alternating +/- max in a high-frequency signal box-averages to ~0
        // (the source's mean over each downsampling window).
        let mut r = Resampler::new(48_000, 16_000); // ratio = 3
                                                    // 6 samples of alternating ±1 → two windows of 3 samples each.
                                                    // Window 1: avg(1, -1, 1) = 1/3 → ~10923
                                                    // Window 2: avg(-1, 1, -1) = -1/3 → ~-10923
        let src: Vec<f32> = (0..6)
            .map(|i| if i % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        let out = drain(&mut r, &src);
        assert_eq!(out.len(), 2, "expected 2 output samples for 6 src @ 3:1");
        let want_pos = to_i16(1.0 / 3.0);
        let want_neg = to_i16(-1.0 / 3.0);
        assert!((out[0] as i32 - want_pos as i32).abs() <= 2);
        assert!((out[1] as i32 - want_neg as i32).abs() <= 2);
        // And both magnitudes are far below saturation — the high-frequency
        // content has been attenuated.
        assert!((out[0] as i32).abs() < (i16::MAX as i32) / 2);
        assert!((out[1] as i32).abs() < (i16::MAX as i32) / 2);
    }

    #[test]
    fn one_packet_versus_many_small_packets_produces_the_same_output() {
        // The Resampler carries `pos` and `last` across packets so a stream
        // arriving in any chunking should yield (modulo a sample or two) the
        // same downsampled output as a single push of the whole buffer.
        let total = 4_800usize; // 100 ms @ 48 kHz
        let src = sine(440.0, 48_000, total, 0.5);

        let mut single = Resampler::new(48_000, 16_000);
        let mut single_out = Vec::new();
        single.push(&src, &mut single_out);

        let mut chunked = Resampler::new(48_000, 16_000);
        let mut chunked_out = Vec::new();
        let mut start = 0usize;
        for &step in &[7usize, 13, 31, 64, 128, 480, 1_024, 2_048] {
            let end = (start + step).min(total);
            chunked.push(&src[start..end], &mut chunked_out);
            start = end;
            if start >= total {
                break;
            }
        }
        if start < total {
            chunked.push(&src[start..], &mut chunked_out);
        }

        // Lengths agree within ±2 (per-packet pos rounding can drop/add a
        // sample at the seams). The first 60 samples of each should also be
        // close in value — we don't get bit-exact equality because chunking
        // changes how `samples[i-1]` is sourced at packet boundaries.
        let diff = (single_out.len() as isize - chunked_out.len() as isize).abs();
        assert!(
            diff <= 2,
            "single={} chunked={}",
            single_out.len(),
            chunked_out.len()
        );
        // Sanity: outputs aren't trivially empty.
        assert!(single_out.len() > 100);
        // Average magnitude per-segment should match closely — we sample 4
        // disjoint windows of 200 samples and compare RMS within tolerance.
        let min_len = single_out.len().min(chunked_out.len());
        for window_start in (0..min_len).step_by(200).take(4) {
            let end = (window_start + 200).min(min_len);
            let rms = |xs: &[i16]| {
                let sum: f64 = xs.iter().map(|&s| (s as f64).powi(2)).sum();
                (sum / xs.len() as f64).sqrt()
            };
            let a = rms(&single_out[window_start..end]);
            let b = rms(&chunked_out[window_start..end]);
            assert!(
                (a - b).abs() < (a.max(b) * 0.10 + 50.0),
                "rms mismatch at {window_start}: single={a:.1} chunked={b:.1}"
            );
        }
    }

    #[test]
    fn ramp_input_produces_monotonic_output() {
        // A linear ramp from 0 → 0.99 should produce monotonic non-decreasing
        // i16 output on the linear-interp path. No regressions in pos tracking
        // and no overflow into negatives.
        let mut r = Resampler::new(16_000, 32_000);
        let src = ramp(160, 0.99);
        let out = drain(&mut r, &src);
        let mut prev = i16::MIN;
        for (i, &s) in out.iter().enumerate() {
            assert!(s >= prev, "non-monotonic at {i}: {prev} -> {s}");
            prev = s;
        }
    }

    #[test]
    fn high_amplitude_input_is_clamped_to_i16_range() {
        // to_i16 must clamp inputs outside [-1, 1] so the final cast can't
        // overflow. Test both the upsample (linear-interp) and downsample
        // (box-average) paths. Warm up first so the carried `last` doesn't
        // pull the first sample toward zero.
        let mut up = Resampler::new(8_000, 16_000);
        warmup(&mut up, 5.0);
        let big = vec![5.0_f32; 32];
        let out_up = drain(&mut up, &big);
        for (i, &s) in out_up.iter().enumerate() {
            assert_eq!(
                s,
                i16::MAX,
                "upsample sample {i}: positive over-amplitude not clamped"
            );
        }

        let mut down = Resampler::new(48_000, 16_000);
        warmup(&mut down, -5.0);
        let neg = vec![-5.0_f32; 96];
        let out_down = drain(&mut down, &neg);
        // to_i16(-1.0) returns -i16::MAX (not i16::MIN) because the
        // implementation multiplies the clamped value by i16::MAX.
        let want = -i16::MAX;
        for (i, &s) in out_down.iter().enumerate() {
            assert_eq!(
                s, want,
                "downsample sample {i}: negative over-amplitude not clamped"
            );
        }
    }

    #[test]
    fn to_i16_helper_clamps_and_quantizes_consistently() {
        // The helper that the resampler relies on for the final f32 → i16
        // conversion: bounds + a couple of midpoints.
        assert_eq!(to_i16(0.0), 0);
        assert_eq!(to_i16(1.0), i16::MAX);
        assert_eq!(to_i16(-1.0), -i16::MAX); // -i16::MAX, not i16::MIN: design choice.
        assert_eq!(to_i16(2.0), i16::MAX);
        assert_eq!(to_i16(-2.0), -i16::MAX);
        // 0.5 -> roughly half of i16::MAX (allow ±1 for float rounding).
        let half = to_i16(0.5);
        let expected = i16::MAX / 2;
        assert!((half as i32 - expected as i32).abs() <= 1);
    }

    // Suppress unused-import warning for PI when the test set doesn't reach
    // for it; this also documents that it's intentionally available for
    // future signal-shape tests.
    #[allow(dead_code)]
    fn _pi_witness() -> f32 {
        PI
    }
}

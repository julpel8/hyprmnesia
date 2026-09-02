use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use hf_hub::api::Progress;
use hpm_util::{emit, SharedOut};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashMap,
    io::{self, BufRead},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use webrtc_vad::{SampleRate, Vad, VadMode};

const DEFAULT_MODEL: &str = "parakeet-tdt-0.6b-v3";
const DEFAULT_SAMPLE_RATE: u32 = 16_000;
const DEFAULT_MIN_SEGMENT_MS: u64 = 750;
const DEFAULT_TARGET_SEGMENT_MS: u64 = 4_000;
const DEFAULT_MAX_SEGMENT_MS: u64 = 6_000;
const DEFAULT_SILENCE_MS: u64 = 700;
const DEFAULT_RMS_GATE: f32 = 0.003;
// CTranslate2 quantization applied when loading a Whisper model. int8 weights
// (~570 MB on disk) load and run on any CPU. The float16 variants need
// GPU-class FP16 support, so they are not the default while the worker pins
// Device::CPU (load_whisper falls back if an unsupported type is requested).
const DEFAULT_COMPUTE_TYPE: &str = "int8";

type SharedModel = Arc<Mutex<ModelSlot>>;

// Whisper runs on CTranslate2 (ct2rs); Parakeet on audiopipe (ONNX). The model
// name prefix picks the family, so one slot holds whichever backend is loaded.
enum Backend {
    Parakeet(audiopipe::Model),
    Whisper(ct2rs::Whisper),
}

enum ModelSlot {
    Empty,
    Loading,
    Ready(Backend),
    Failed(String),
}

#[derive(Clone)]
struct Config {
    model: String,
    language: Option<String>,
    compute_type: String,
    sample_rate: u32,
    min_segment_ms: u64,
    target_segment_ms: u64,
    max_segment_ms: u64,
    silence_ms: u64,
    rms_gate: f32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            model: DEFAULT_MODEL.to_string(),
            language: None,
            compute_type: DEFAULT_COMPUTE_TYPE.to_string(),
            sample_rate: DEFAULT_SAMPLE_RATE,
            min_segment_ms: DEFAULT_MIN_SEGMENT_MS,
            target_segment_ms: DEFAULT_TARGET_SEGMENT_MS,
            max_segment_ms: DEFAULT_MAX_SEGMENT_MS,
            silence_ms: DEFAULT_SILENCE_MS,
            rms_gate: DEFAULT_RMS_GATE,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Request {
    Init {
        model: Option<String>,
        language: Option<String>,
        compute_type: Option<String>,
        sample_rate: Option<u32>,
        min_segment_ms: Option<u64>,
        target_segment_ms: Option<u64>,
        max_segment_ms: Option<u64>,
        silence_ms: Option<u64>,
        rms_gate: Option<f32>,
    },
    Audio {
        source: String,
        chunk_id: String,
        at: u64,
        sample_rate: u32,
        pcm_b64: String,
    },
    Flush {
        id: Option<String>,
        source: Option<String>,
    },
    Shutdown,
}

struct AudioFrame {
    source: String,
    chunk_id: String,
    at: u64,
    sample_rate: u32,
    samples: Vec<f32>,
}

struct SegmentAudio {
    source: String,
    chunk_id: String,
    start_at: u64,
    end_at: u64,
    samples: Vec<f32>,
}

struct SourceVad {
    vad: Vad,
    segment: Vec<f32>,
    source: String,
    chunk_id: Option<String>,
    start_at: Option<u64>,
    end_at: Option<u64>,
    silence_ms: u64,
    // Voiced audio accumulated in the current segment. A segment grows by both
    // voiced frames and the short non-voice frames kept between them (pauses,
    // breaths). `min_segment_ms` gates on *this* rather than the total length so
    // a segment padded with silence — the kind that makes Whisper hallucinate
    // canned filler ("Yeah.", "Thank you.", "Продолжение следует...") — never
    // reaches the model.
    voiced_samples: usize,
}

impl SourceVad {
    fn new(source: &str) -> Self {
        let mode = if source == "mic" {
            // Real microphones are noisier and less consistent than mixer
            // capture. A less aggressive VAD catches user speech that the
            // clean-system-audio setting was rejecting.
            VadMode::Quality
        } else {
            VadMode::Aggressive
        };
        Self {
            vad: Vad::new_with_rate_and_mode(SampleRate::Rate16kHz, mode),
            segment: Vec::new(),
            source: source.to_string(),
            chunk_id: None,
            start_at: None,
            end_at: None,
            silence_ms: 0,
            voiced_samples: 0,
        }
    }

    fn push(&mut self, frame: AudioFrame, cfg: &Config) -> Vec<SegmentAudio> {
        let mut ready = Vec::new();
        if self
            .chunk_id
            .as_ref()
            .is_some_and(|chunk_id| chunk_id != &frame.chunk_id)
        {
            if let Some(segment) = self.take(cfg, false) {
                ready.push(segment);
            }
        }

        let frame_ms = samples_to_ms(frame.samples.len(), frame.sample_rate);
        let frame_end = frame.at.saturating_add(frame_ms);
        let rms = rms(&frame.samples);
        let speech = rms >= cfg.rms_gate && self.is_voice(&frame.samples);

        if speech {
            if self.segment.is_empty() {
                self.source = frame.source.clone();
                self.chunk_id = Some(frame.chunk_id.clone());
                self.start_at = Some(frame.at);
            }
            self.segment.extend_from_slice(&frame.samples);
            self.voiced_samples = self.voiced_samples.saturating_add(frame.samples.len());
            self.end_at = Some(frame_end);
            self.silence_ms = 0;

            let duration = samples_to_ms(self.segment.len(), cfg.sample_rate);
            if duration >= cfg.max_segment_ms || duration >= cfg.target_segment_ms {
                if let Some(segment) = self.take(cfg, false) {
                    ready.push(segment);
                }
            }
        } else if !self.segment.is_empty() {
            // Once speech has started, keep short non-voice frames in the
            // segment. Normal mic speech contains pauses, breaths, and
            // unvoiced consonants; dropping those frames made user speech too
            // short to pass `min_segment_ms`, so mic transcripts disappeared.
            self.segment.extend_from_slice(&frame.samples);
            self.end_at = Some(frame_end);
            self.silence_ms = self.silence_ms.saturating_add(frame_ms);
            if self.silence_ms >= cfg.silence_ms {
                if let Some(segment) = self.take(cfg, false) {
                    ready.push(segment);
                }
            }
        }

        ready
    }

    fn flush(&mut self, cfg: &Config) -> Option<SegmentAudio> {
        self.take(cfg, true)
    }

    fn is_voice(&mut self, samples: &[f32]) -> bool {
        let pcm: Vec<i16> = samples
            .iter()
            .map(|sample| {
                let clamped = sample.clamp(-1.0, 1.0);
                (clamped * i16::MAX as f32) as i16
            })
            .collect();
        self.vad.is_voice_segment(&pcm).unwrap_or(false)
    }

    fn take(&mut self, cfg: &Config, force: bool) -> Option<SegmentAudio> {
        if self.segment.is_empty() {
            return None;
        }
        // Gate on voiced audio, not total length: a segment can be mostly the
        // silence kept between voiced frames, and CTranslate2's Whisper (unlike
        // faster-whisper) exposes no `no_speech_prob`, so non-speech reaching it
        // is transcribed as hallucinated filler. Requiring `min_segment_ms` of
        // actual voice keeps those segments out of the model entirely.
        let voiced_ms = samples_to_ms(self.voiced_samples, cfg.sample_rate);
        if !force && voiced_ms < cfg.min_segment_ms {
            self.reset();
            return None;
        }
        let samples = std::mem::take(&mut self.segment);
        let source = self.source.clone();
        let chunk_id = self.chunk_id.take()?;
        let start_at = self.start_at.take()?;
        let end_at = self.end_at.take().unwrap_or(start_at);
        self.silence_ms = 0;
        self.voiced_samples = 0;
        Some(SegmentAudio {
            source,
            chunk_id,
            start_at,
            end_at,
            samples,
        })
    }

    fn reset(&mut self) {
        self.segment.clear();
        self.chunk_id = None;
        self.start_at = None;
        self.end_at = None;
        self.silence_ms = 0;
        self.voiced_samples = 0;
    }
}

fn main() -> Result<()> {
    let out = Arc::new(Mutex::new(io::stdout()));
    let model = Arc::new(Mutex::new(ModelSlot::Empty));
    let mut cfg = Config::default();
    let mut sources: HashMap<String, SourceVad> = HashMap::new();

    for line in io::stdin().lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(&line) {
            Ok(req) => req,
            Err(err) => {
                emit(
                    &out,
                    json!({ "type": "error", "message": format!("invalid request: {err}") }),
                );
                continue;
            }
        };

        match req {
            Request::Init {
                model: model_name,
                language,
                compute_type,
                sample_rate,
                min_segment_ms,
                target_segment_ms,
                max_segment_ms,
                silence_ms,
                rms_gate,
            } => {
                cfg.model = model_name.unwrap_or_else(|| DEFAULT_MODEL.to_string());
                cfg.language = language.filter(|lang| !lang.trim().is_empty());
                cfg.compute_type = compute_type
                    .filter(|ct| !ct.trim().is_empty())
                    .unwrap_or_else(|| DEFAULT_COMPUTE_TYPE.to_string());
                cfg.sample_rate = sample_rate.unwrap_or(DEFAULT_SAMPLE_RATE);
                cfg.min_segment_ms = min_segment_ms.unwrap_or(DEFAULT_MIN_SEGMENT_MS);
                cfg.target_segment_ms = target_segment_ms.unwrap_or(DEFAULT_TARGET_SEGMENT_MS);
                cfg.max_segment_ms = max_segment_ms.unwrap_or(DEFAULT_MAX_SEGMENT_MS);
                cfg.silence_ms = silence_ms.unwrap_or(DEFAULT_SILENCE_MS);
                cfg.rms_gate = rms_gate.unwrap_or(DEFAULT_RMS_GATE);
                start_model_loader(
                    cfg.model.clone(),
                    cfg.compute_type.clone(),
                    out.clone(),
                    model.clone(),
                );
            }
            Request::Audio {
                source,
                chunk_id,
                at,
                sample_rate,
                pcm_b64,
            } => {
                if !model_ready(&model) {
                    continue;
                }
                if sample_rate != cfg.sample_rate {
                    emit(
                        &out,
                        json!({
                            "type": "error",
                            "source": source,
                            "message": format!("unexpected sample rate {sample_rate}; expected {}", cfg.sample_rate),
                        }),
                    );
                    continue;
                }
                let frame = match decode_audio(source, chunk_id, at, sample_rate, &pcm_b64) {
                    Ok(frame) => frame,
                    Err(err) => {
                        emit(&out, json!({ "type": "error", "message": err.to_string() }));
                        continue;
                    }
                };
                let source_state = sources
                    .entry(frame.source.clone())
                    .or_insert_with(|| SourceVad::new(&frame.source));
                for segment in source_state.push(frame, &cfg) {
                    transcribe_segment(&out, &model, &cfg, segment);
                }
            }
            Request::Flush { id, source } => {
                if let Some(source) = source {
                    if let Some(source_state) = sources.get_mut(&source) {
                        if let Some(segment) = source_state.flush(&cfg) {
                            transcribe_segment(&out, &model, &cfg, segment);
                        }
                    }
                } else {
                    for source_state in sources.values_mut() {
                        if let Some(segment) = source_state.flush(&cfg) {
                            transcribe_segment(&out, &model, &cfg, segment);
                        }
                    }
                }
                emit(&out, json!({ "type": "flushed", "id": id }));
            }
            Request::Shutdown => {
                for source_state in sources.values_mut() {
                    if let Some(segment) = source_state.flush(&cfg) {
                        transcribe_segment(&out, &model, &cfg, segment);
                    }
                }
                emit(
                    &out,
                    json!({ "type": "status", "status": "stopped", "engine": engine_name(&cfg) }),
                );
                break;
            }
        }
    }

    Ok(())
}

fn start_model_loader(name: String, compute_type: String, out: SharedOut, slot: SharedModel) {
    {
        let mut guard = slot.lock().expect("model lock");
        if matches!(&*guard, ModelSlot::Loading | ModelSlot::Ready(_)) {
            return;
        }
        *guard = ModelSlot::Loading;
    }

    emit(
        &out,
        json!({ "type": "status", "status": "loading", "engine": engine_name_for(&name), "message": format!("loading {} model", model_family(&name)) }),
    );
    thread::spawn(move || {
        let loaded = if is_whisper(&name) {
            load_whisper(&name, &compute_type, &out).map(Backend::Whisper)
        } else {
            load_parakeet(&name, &out).map(Backend::Parakeet)
        };

        match loaded {
            Ok(backend) => {
                {
                    let mut guard = slot.lock().expect("model lock");
                    *guard = ModelSlot::Ready(backend);
                }
                emit(
                    &out,
                    json!({ "type": "ready", "engine": engine_name_for(&name), "model": name }),
                );
            }
            Err(err) => {
                {
                    let mut guard = slot.lock().expect("model lock");
                    *guard = ModelSlot::Failed(format!("{err:#}"));
                }
                emit(
                    &out,
                    json!({
                        "type": "error",
                        "engine": engine_name_for(&name),
                        // `{err:#}` includes the full anyhow context chain (e.g. the
                        // underlying transport error), not just the outermost message.
                        "message": format!("{} model failed: {err:#}", model_family(&name))
                    }),
                );
            }
        }
    });
}

fn load_parakeet(name: &str, out: &SharedOut) -> Result<audiopipe::Model> {
    match audiopipe::Model::from_pretrained_cache_only(name) {
        Ok(model) => Ok(model),
        Err(err) if err.is_model_not_cached() => {
            emit(
                out,
                json!({
                    "type": "status",
                    "status": "downloading",
                    "engine": engine_name_for(name),
                    "message": format!("downloading {} model", model_family(name))
                }),
            );
            audiopipe::Model::from_pretrained(name).map_err(|err| anyhow!(err.to_string()))
        }
        Err(err) => Err(anyhow!(err.to_string())),
    }
}

// Pulls a faster-whisper CTranslate2 model from the Hugging Face cache (mirroring
// hpm-embed) and hands the snapshot directory to ct2rs. Older Systran repos ship
// no preprocessor_config.json, so we synthesize one when missing; the vocabulary
// is `vocabulary.json` on newer repos and `vocabulary.txt` on older ones.
fn load_whisper(name: &str, compute_type: &str, out: &SharedOut) -> Result<ct2rs::Whisper> {
    let (repo_id, feature_size) = whisper_repo(name)?;
    let api = hf_hub::api::sync::Api::new().context("init hf-hub api")?;
    let repo = api.model(repo_id.to_string());

    let cached = hf_hub::Cache::default()
        .model(repo_id.to_string())
        .get("model.bin")
        .is_some();
    if !cached {
        emit(
            out,
            json!({
                "type": "status",
                "status": "downloading",
                "engine": engine_name_for(name),
                "message": format!("downloading {} model", model_family(name))
            }),
        );
    }

    let config_path = with_retry(out, name, "config.json", || repo.get("config.json"))?;
    let model_dir = config_path
        .parent()
        .ok_or_else(|| anyhow!("whisper model snapshot directory not found"))?
        .to_path_buf();
    // The weights dominate the download, so stream them with progress when not
    // already cached. The remaining files are tiny — a plain cache-aware get is
    // enough. All get wrapped in retry: a transient blip on a small file (the
    // observed `tokenizer.json` failure) shouldn't abort the whole load.
    if cached {
        with_retry(out, name, "model.bin", || repo.get("model.bin"))?;
    } else {
        with_retry(out, name, "model.bin", || {
            repo.download_with_progress("model.bin", DownloadProgress::new(out.clone(), name))
        })?;
    }
    with_retry(out, name, "tokenizer.json", || repo.get("tokenizer.json"))?;
    with_retry(out, name, "whisper vocabulary", || {
        repo.get("vocabulary.json")
            .or_else(|_| repo.get("vocabulary.txt"))
    })?;
    if repo.get("preprocessor_config.json").is_err() {
        write_preprocessor_config(&model_dir, feature_size)
            .context("write preprocessor_config.json")?;
    }

    let requested = parse_compute_type(compute_type);
    let make_config = |ct| ct2rs::Config {
        device: ct2rs::Device::CPU,
        compute_type: ct,
        ..Default::default()
    };
    match ct2rs::Whisper::new(&model_dir, make_config(requested)) {
        Ok(whisper) => Ok(whisper),
        Err(err) => {
            // GPU-oriented compute types (int8_float16, float16, bfloat16) are
            // not supported on plain CPU and fail at load. Retry once with the
            // model's native quantization rather than failing the engine.
            let message = err.to_string();
            if requested != ct2rs::ComputeType::DEFAULT && message.contains("compute type") {
                emit(
                    out,
                    json!({
                        "type": "status",
                        "status": "loading",
                        "engine": engine_name_for(name),
                        "message": format!(
                            "compute type {compute_type} unsupported on this device; using default"
                        ),
                    }),
                );
                ct2rs::Whisper::new(&model_dir, make_config(ct2rs::ComputeType::DEFAULT))
                    .map_err(|err| anyhow!(err.to_string()))
            } else {
                Err(anyhow!(message))
            }
        }
    }
}

// Synthesizes the standard WhisperFeatureExtractor config for repos that omit it.
// Every field is fixed across Whisper sizes except `feature_size` (80 mel bins,
// or 128 for large-v3 / large-v3-turbo). `mel_filters` is intentionally absent so
// ct2rs computes the filterbank itself.
fn write_preprocessor_config(model_dir: &std::path::Path, feature_size: usize) -> Result<()> {
    let config = json!({
        "chunk_length": 30,
        "feature_extractor_type": "WhisperFeatureExtractor",
        "feature_size": feature_size,
        "hop_length": 160,
        "n_fft": 400,
        "n_samples": 480_000,
        "nb_max_frames": 3_000,
        "padding_side": "right",
        "padding_value": 0.0,
        "processor_class": "WhisperProcessor",
        "return_attention_mask": false,
        "sampling_rate": 16_000
    });
    std::fs::write(
        model_dir.join("preprocessor_config.json"),
        serde_json::to_vec_pretty(&config)?,
    )?;
    Ok(())
}

// Retries a Hugging Face fetch a few times with exponential backoff. Transient
// failures (timeouts, 429s, a connection dropped mid-download — e.g. the
// observed `tokenizer.json` error after model.bin already succeeded) shouldn't
// abort a multi-minute model load on the first blip. Each retry is surfaced as a
// downloading status so the UI shows activity rather than appearing to hang.
fn with_retry<T>(
    out: &SharedOut,
    name: &str,
    filename: &str,
    mut op: impl FnMut() -> std::result::Result<T, hf_hub::api::sync::ApiError>,
) -> Result<T> {
    const ATTEMPTS: u32 = 4;
    let mut delay = Duration::from_secs(1);
    for attempt in 1..=ATTEMPTS {
        match op() {
            Ok(value) => return Ok(value),
            Err(_) if attempt < ATTEMPTS => {
                emit(
                    out,
                    json!({
                        "type": "status",
                        "status": "downloading",
                        "engine": engine_name_for(name),
                        "message": format!("retrying {filename} ({attempt}/{ATTEMPTS})"),
                    }),
                );
                thread::sleep(delay);
                delay = (delay * 2).min(Duration::from_secs(8));
            }
            Err(err) => return Err(err).context(format!("download {filename}")),
        }
    }
    unreachable!("retry loop returns on the final attempt")
}

// Percentage of a download given bytes received so far. None when the total size
// is unknown (the hub occasionally omits Content-Length).
fn progress_pct(downloaded: usize, total: usize) -> Option<i64> {
    if total == 0 {
        return None;
    }
    Some(((downloaded as u128 * 100) / total as u128).min(100) as i64)
}

// Throttle: emit only on a >=2-point advance and at most ~once every 400ms, so a
// few-hundred-MB model produces ~50 status lines (each becomes a daemon-log
// line) instead of thousands.
fn should_emit_progress(pct: i64, last_pct: i64, elapsed: Duration) -> bool {
    pct >= last_pct + 2 && elapsed >= Duration::from_millis(400)
}

// Streams hf-hub download progress to stdout as throttled `downloading` status
// lines carrying a 0–100 `progress`, which the daemon forwards to the TUI's
// status panel.
struct DownloadProgress {
    out: SharedOut,
    engine: String,
    family: &'static str,
    total: usize,
    downloaded: usize,
    last_pct: i64,
    last_emit: Instant,
}

impl DownloadProgress {
    fn new(out: SharedOut, name: &str) -> Self {
        Self {
            out,
            engine: engine_name_for(name),
            family: model_family(name),
            total: 0,
            downloaded: 0,
            last_pct: 0,
            last_emit: Instant::now(),
        }
    }

    fn emit_pct(&self, pct: i64) {
        emit(
            &self.out,
            json!({
                "type": "status",
                "status": "downloading",
                "engine": self.engine,
                "message": format!("downloading {} model", self.family),
                "progress": pct,
            }),
        );
    }
}

impl Progress for DownloadProgress {
    fn init(&mut self, size: usize, _filename: &str) {
        // Called before bytes flow (and again on a resumed connection). Record
        // the size; the first percentage comes from `update` once it clears the
        // throttle, so we don't double-report 0% next to the plain "downloading"
        // status load_whisper already sent.
        self.total = size;
        self.downloaded = 0;
        self.last_pct = 0;
        self.last_emit = Instant::now();
    }

    fn update(&mut self, size: usize) {
        self.downloaded = self.downloaded.saturating_add(size);
        let Some(pct) = progress_pct(self.downloaded, self.total) else {
            return;
        };
        if should_emit_progress(pct, self.last_pct, self.last_emit.elapsed()) {
            self.last_pct = pct;
            self.last_emit = Instant::now();
            self.emit_pct(pct);
        }
    }

    fn finish(&mut self) {
        if self.last_pct < 100 {
            self.last_pct = 100;
            self.emit_pct(100);
        }
    }
}

fn model_ready(model: &SharedModel) -> bool {
    let guard = model.lock().expect("model lock");
    matches!(&*guard, ModelSlot::Ready(_))
}

fn transcribe_segment(out: &SharedOut, model: &SharedModel, cfg: &Config, segment: SegmentAudio) {
    if rms(&segment.samples) < cfg.rms_gate {
        return;
    }
    let start = Instant::now();
    let result: Result<String> = {
        let mut guard = model.lock().expect("model lock");
        match &mut *guard {
            ModelSlot::Ready(Backend::Parakeet(model)) => model
                .transcribe_with_sample_rate(
                    &segment.samples,
                    cfg.sample_rate,
                    transcribe_options(cfg),
                )
                .map(|result| result.text)
                .map_err(|err| anyhow!(err.to_string())),
            ModelSlot::Ready(Backend::Whisper(whisper)) => whisper
                .generate(
                    &segment.samples,
                    whisper_language(cfg),
                    false,
                    &whisper_options(),
                )
                .map(|segments| segments.join(" "))
                .map_err(|err| anyhow!(err.to_string())),
            ModelSlot::Failed(err) => Err(anyhow!(err.clone())),
            _ => Err(anyhow!("{} is not ready", model_family(&cfg.model))),
        }
    };

    match result {
        Ok(result) => {
            let text = result.trim();
            if text.is_empty() || is_hallucination(text) {
                return;
            }
            emit(
                &out,
                json!({
                    "type": "segment_final",
                    "source": segment.source,
                    "chunk_id": segment.chunk_id,
                    "start_at": segment.start_at,
                    "end_at": segment.end_at,
                    "text": text,
                    "engine": engine_name(cfg),
                    "transcribe_ms": start.elapsed().as_millis() as u64,
                }),
            );
        }
        Err(err) => emit(
            &out,
            json!({
                "type": "error",
                "source": segment.source,
                "chunk_id": segment.chunk_id,
                "message": format!("{} transcription failed: {err}", model_family(&cfg.model)),
            }),
        ),
    }
}

fn decode_audio(
    source: String,
    chunk_id: String,
    at: u64,
    sample_rate: u32,
    pcm_b64: &str,
) -> Result<AudioFrame> {
    let pcm = BASE64.decode(pcm_b64).context("invalid base64 PCM")?;
    if pcm.len() % 2 != 0 {
        return Err(anyhow!("PCM frame has odd byte length"));
    }
    let samples = pcm
        .chunks_exact(2)
        .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / 32768.0)
        .collect();
    Ok(AudioFrame {
        source,
        chunk_id,
        at,
        sample_rate,
        samples,
    })
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum = samples.iter().map(|sample| sample * sample).sum::<f32>();
    (sum / samples.len() as f32).sqrt()
}

fn samples_to_ms(samples: usize, sample_rate: u32) -> u64 {
    ((samples as u64) * 1000) / sample_rate as u64
}

fn engine_name(cfg: &Config) -> String {
    engine_name_for(&cfg.model)
}

// The model name prefix selects the backend family: `whisper-*` runs on
// CTranslate2 (ct2rs), everything else on audiopipe (Parakeet). Engine names and
// status messages mirror that so the daemon reports the backend actually loaded.
fn is_whisper(model: &str) -> bool {
    model.starts_with("whisper")
}

fn model_family(model: &str) -> &'static str {
    if is_whisper(model) {
        "Whisper"
    } else {
        "Parakeet"
    }
}

fn engine_name_for(model: &str) -> String {
    if is_whisper(model) {
        format!("whisper:{model}")
    } else {
        format!("parakeet:{model}")
    }
}

// Maps a whisper-* model name to its faster-whisper CTranslate2 repo and mel-bin
// count (80, or 128 for large-v3 / large-v3-turbo). Kept in sync with
// WHISPER_MODELS in src/process/transcription/native_asr.ts and src/config.ts.
fn whisper_repo(model: &str) -> Result<(&'static str, usize)> {
    Ok(match model {
        "whisper-tiny" => ("Systran/faster-whisper-tiny", 80),
        "whisper-base" => ("Systran/faster-whisper-base", 80),
        "whisper-small" => ("Systran/faster-whisper-small", 80),
        "whisper-medium" => ("Systran/faster-whisper-medium", 80),
        "whisper-large-v3" => ("Systran/faster-whisper-large-v3", 128),
        "whisper-large-v3-turbo" => ("deepdml/faster-whisper-large-v3-turbo-ct2", 128),
        other => return Err(anyhow!("unknown whisper model: {other}")),
    })
}

// Quantization for CTranslate2 model loading. Unknown values fall back to the
// configured default rather than failing the load.
fn parse_compute_type(value: &str) -> ct2rs::ComputeType {
    use ct2rs::ComputeType;
    match value {
        "int8" => ComputeType::INT8,
        "int8_float16" => ComputeType::INT8_FLOAT16,
        "int8_float32" => ComputeType::INT8_FLOAT32,
        "int8_bfloat16" => ComputeType::INT8_BFLOAT16,
        "int16" => ComputeType::INT16,
        "float16" => ComputeType::FLOAT16,
        "bfloat16" => ComputeType::BFLOAT16,
        "float32" => ComputeType::FLOAT32,
        "auto" => ComputeType::AUTO,
        "default" => ComputeType::DEFAULT,
        _ => ComputeType::INT8,
    }
}

// Whisper language hint passed to ct2rs: None triggers per-segment auto-detect.
// 'auto' and empty both mean "detect".
fn whisper_language(cfg: &Config) -> Option<&str> {
    cfg.language
        .as_deref()
        .filter(|lang| !lang.is_empty() && *lang != "auto")
}

// Decoder options for ct2rs Whisper. ct2rs exposes none of faster-whisper's
// no_speech/logprob thresholds, so the only in-decoder guard we have against
// the repetition loops Whisper falls into on near-silence ("you you you",
// "merci merci merci") is to forbid repeated n-grams and penalize repetition.
fn whisper_options() -> ct2rs::WhisperOptions {
    let mut opts = ct2rs::WhisperOptions::default();
    opts.no_repeat_ngram_size = 3;
    opts.repetition_penalty = 1.1;
    opts
}

// Canned phrases Whisper emits when handed non-speech audio — subtitle/credit
// boilerplate baked into the training data. None of these are plausible user
// speech, so dropping them is safe; genuinely short utterances ("oui", "okay")
// are left to the voiced-duration gate, not this list. Matched against the
// lowercased transcript via substring, so trailing punctuation/casing don't
// matter.
const HALLUCINATION_MARKERS: &[&str] = &[
    "amara.org",
    "продолжение следует",
    "thanks for watching",
    "thank you for watching",
    "please subscribe",
    "see you in the next video",
    "sous-titrage",
    "sous-titres réalisés",
    "merci d'avoir regardé",
    "ご視聴ありがとうございました",
];

fn is_hallucination(text: &str) -> bool {
    let normalized = text.to_lowercase();
    HALLUCINATION_MARKERS
        .iter()
        .any(|marker| normalized.contains(marker))
}

fn transcribe_options(cfg: &Config) -> audiopipe::TranscribeOptions {
    let mut opts = audiopipe::TranscribeOptions::default();
    if let Some(lang) = &cfg.language {
        opts.language = Some(lang.clone());
    }
    opts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_name_follows_model_family() {
        assert_eq!(
            engine_name_for("parakeet-tdt-0.6b-v3"),
            "parakeet:parakeet-tdt-0.6b-v3"
        );
        assert_eq!(
            engine_name_for("whisper-large-v3-turbo"),
            "whisper:whisper-large-v3-turbo"
        );
        assert_eq!(model_family("whisper-small"), "Whisper");
        assert_eq!(model_family("parakeet-tdt-0.6b-v3"), "Parakeet");
    }

    #[test]
    fn init_request_accepts_optional_language() {
        let with_language: Request = serde_json::from_str(
            r#"{"type":"init","model":"whisper-small","language":"fr","sample_rate":16000}"#,
        )
        .expect("init with language");
        match with_language {
            Request::Init {
                model, language, ..
            } => {
                assert_eq!(model.as_deref(), Some("whisper-small"));
                assert_eq!(language.as_deref(), Some("fr"));
            }
            _ => panic!("expected init"),
        }

        let without_language: Request =
            serde_json::from_str(r#"{"type":"init","model":"parakeet-tdt-0.6b-v3"}"#)
                .expect("init without language");
        match without_language {
            Request::Init { language, .. } => assert_eq!(language, None),
            _ => panic!("expected init"),
        }
    }

    #[test]
    fn init_request_accepts_optional_compute_type() {
        let with_compute: Request = serde_json::from_str(
            r#"{"type":"init","model":"whisper-small","compute_type":"int8"}"#,
        )
        .expect("init with compute_type");
        match with_compute {
            Request::Init { compute_type, .. } => {
                assert_eq!(compute_type.as_deref(), Some("int8"))
            }
            _ => panic!("expected init"),
        }

        let without_compute: Request =
            serde_json::from_str(r#"{"type":"init","model":"whisper-small"}"#)
                .expect("init without compute_type");
        match without_compute {
            Request::Init { compute_type, .. } => assert_eq!(compute_type, None),
            _ => panic!("expected init"),
        }
    }

    #[test]
    fn transcribe_options_propagates_language() {
        let mut cfg = Config::default();
        assert_eq!(transcribe_options(&cfg).language, None);
        cfg.language = Some("auto".to_string());
        assert_eq!(transcribe_options(&cfg).language.as_deref(), Some("auto"));
    }

    #[test]
    fn whisper_language_skips_auto_and_empty() {
        let mut cfg = Config::default();
        assert_eq!(whisper_language(&cfg), None);
        cfg.language = Some("auto".to_string());
        assert_eq!(whisper_language(&cfg), None);
        cfg.language = Some(String::new());
        assert_eq!(whisper_language(&cfg), None);
        cfg.language = Some("fr".to_string());
        assert_eq!(whisper_language(&cfg), Some("fr"));
    }

    #[test]
    fn whisper_repo_maps_known_models() {
        assert_eq!(
            whisper_repo("whisper-tiny").unwrap(),
            ("Systran/faster-whisper-tiny", 80)
        );
        assert_eq!(
            whisper_repo("whisper-large-v3").unwrap(),
            ("Systran/faster-whisper-large-v3", 128)
        );
        assert_eq!(
            whisper_repo("whisper-large-v3-turbo").unwrap(),
            ("deepdml/faster-whisper-large-v3-turbo-ct2", 128)
        );
        assert!(whisper_repo("whisper-large-v3-turbo-q5").is_err());
    }

    #[test]
    fn flags_known_hallucinations_only() {
        // Canned credit/boilerplate Whisper emits on non-speech — dropped.
        assert!(is_hallucination("Продолжение следует..."));
        assert!(is_hallucination("Subtitles by the Amara.org community"));
        assert!(is_hallucination("Thanks for watching!"));
        assert!(is_hallucination("Sous-titrage ST' 501"));
        assert!(is_hallucination("Merci d'avoir regardé cette vidéo."));
        // Real (if short) speech is left to the voiced-duration gate, not dropped here.
        assert!(!is_hallucination("Okay."));
        assert!(!is_hallucination("Oui, d'accord."));
        assert!(!is_hallucination("Thank you, that helps a lot."));
    }

    #[test]
    fn whisper_options_guard_against_repetition_loops() {
        let opts = whisper_options();
        assert_eq!(opts.no_repeat_ngram_size, 3);
        assert!(opts.repetition_penalty > 1.0);
    }

    fn loaded_segment(voiced_samples: usize, total_samples: usize) -> SourceVad {
        let mut vad = SourceVad::new("mic");
        vad.segment = vec![0.1; total_samples];
        vad.voiced_samples = voiced_samples;
        vad.chunk_id = Some("c1".to_string());
        vad.start_at = Some(1_000);
        vad.end_at = Some(2_000);
        vad
    }

    #[test]
    fn take_gates_on_voiced_duration_not_total_length() {
        let cfg = Config::default(); // min_segment_ms = 750
        let sr = cfg.sample_rate as usize;
        let half_second = sr / 2; // 500 ms — below the 750 ms voiced floor
        let one_second = sr; // 1000 ms

        // A long segment (4 s total) padded with silence but only 500 ms of
        // voice is dropped: this is the shape that made Whisper hallucinate.
        let mut padded = loaded_segment(half_second, sr * 4);
        assert!(padded.take(&cfg, false).is_none());

        // Enough actual voice passes even if total length is identical.
        let mut speechy = loaded_segment(one_second, sr * 4);
        assert!(speechy.take(&cfg, false).is_some());

        // A forced flush bypasses the gate so trailing real speech is never lost.
        let mut forced = loaded_segment(half_second, sr * 4);
        assert!(forced.take(&cfg, true).is_some());
    }

    #[test]
    fn parse_compute_type_known_and_fallback() {
        use ct2rs::ComputeType;
        assert_eq!(parse_compute_type("int8"), ComputeType::INT8);
        assert_eq!(
            parse_compute_type("int8_float16"),
            ComputeType::INT8_FLOAT16
        );
        assert_eq!(parse_compute_type("float32"), ComputeType::FLOAT32);
        // Unknown values fall back to the configured default (CPU-safe int8).
        assert_eq!(parse_compute_type("nonsense"), ComputeType::INT8);
    }

    #[test]
    fn progress_pct_clamps_and_handles_unknown_total() {
        assert_eq!(progress_pct(0, 0), None);
        assert_eq!(progress_pct(100, 0), None);
        assert_eq!(progress_pct(0, 200), Some(0));
        assert_eq!(progress_pct(50, 200), Some(25));
        assert_eq!(progress_pct(200, 200), Some(100));
        // Over-count (resumed/duplicated chunks) never exceeds 100.
        assert_eq!(progress_pct(250, 200), Some(100));
    }

    #[test]
    fn should_emit_progress_throttles_by_step_and_time() {
        let ok = Duration::from_millis(400);
        let soon = Duration::from_millis(399);
        // Needs both a >=2-point advance and enough elapsed time.
        assert!(should_emit_progress(2, 0, ok));
        assert!(should_emit_progress(10, 8, ok));
        assert!(!should_emit_progress(1, 0, ok)); // <2-point advance
        assert!(!should_emit_progress(10, 9, ok)); // <2-point advance
        assert!(!should_emit_progress(50, 0, soon)); // too soon
    }
}

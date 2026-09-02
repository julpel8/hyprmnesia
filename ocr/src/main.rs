// hpm-ocr: read an image path from argv[1], emit a single JSON line on stdout:
// { "ok": true, "engine": "...", "text": "...", "lines": [...], "language": "..." }
// or { "ok": false, "error": "..." }
//
// On Windows uses Windows.Media.Ocr (built into Windows 10+).
// On macOS uses Apple's Vision text recognition framework.
// Other platforms exit with an error JSON so the TS side can fall back to
// tesseract.

use serde::Serialize;
use std::env;
use std::io::{self, Write};
use std::path::Path;
use std::process::ExitCode;

#[derive(Serialize)]
struct OkResponse<'a> {
    ok: bool,
    engine: &'a str,
    text: String,
    lines: Vec<String>,
    language: Option<String>,
}

#[derive(Serialize)]
struct ErrResponse<'a> {
    ok: bool,
    error: String,
    engine: &'a str,
}

fn emit_err(engine: &str, msg: impl Into<String>) -> ExitCode {
    let body = ErrResponse {
        ok: false,
        error: msg.into(),
        engine,
    };
    let s = serde_json::to_string(&body).unwrap_or_else(|_| "{\"ok\":false}".into());
    let _ = writeln!(io::stdout(), "{s}");
    ExitCode::from(1)
}

fn run() -> ExitCode {
    let path = match env::args().nth(1) {
        Some(p) => p,
        None => return emit_err(engine_name(), "missing image path argument"),
    };
    let p = Path::new(&path);
    if !p.exists() {
        return emit_err(engine_name(), format!("image not found: {path}"));
    }

    match ocr(p) {
        Ok(result) => {
            let s = serde_json::to_string(&result).unwrap_or_else(|_| "{\"ok\":false}".into());
            let _ = writeln!(io::stdout(), "{s}");
            ExitCode::SUCCESS
        }
        Err(e) => emit_err(engine_name(), e),
    }
}

fn main() -> ExitCode {
    run()
}

#[cfg(windows)]
fn engine_name() -> &'static str {
    "windows-media-ocr"
}

#[cfg(target_os = "macos")]
fn engine_name() -> &'static str {
    "apple-vision-ocr"
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn engine_name() -> &'static str {
    "unsupported"
}

#[cfg(windows)]
fn ocr(path: &Path) -> Result<OkResponse<'static>, String> {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::{FileAccessMode, StorageFile};

    let abs = std::fs::canonicalize(path).map_err(|e| format!("canonicalize: {e}"))?;
    let abs_str = abs.to_string_lossy().replace("\\\\?\\", "");
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(abs_str.as_str()))
        .map_err(|e| format!("GetFileFromPathAsync: {e}"))?
        .get()
        .map_err(|e| format!("await GetFileFromPathAsync: {e}"))?;
    let stream = file
        .OpenAsync(FileAccessMode::Read)
        .map_err(|e| format!("OpenAsync: {e}"))?
        .get()
        .map_err(|e| format!("await OpenAsync: {e}"))?;
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|e| format!("BitmapDecoder::CreateAsync: {e}"))?
        .get()
        .map_err(|e| format!("await BitmapDecoder::CreateAsync: {e}"))?;
    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|e| format!("GetSoftwareBitmapAsync: {e}"))?
        .get()
        .map_err(|e| format!("await GetSoftwareBitmapAsync: {e}"))?;

    // try preferred user-language engine first; fall back to whichever is available
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .or_else(|_| {
            OcrEngine::TryCreateFromLanguage(&Language::CreateLanguage(&HSTRING::from("en-US"))?)
        })
        .map_err(|e| format!("OcrEngine creation failed: {e}"))?;

    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| format!("RecognizeAsync: {e}"))?
        .get()
        .map_err(|e| format!("await RecognizeAsync: {e}"))?;

    let text = result
        .Text()
        .map(|t| t.to_string_lossy())
        .unwrap_or_default();
    let mut lines = Vec::new();
    if let Ok(line_iter) = result.Lines() {
        if let Ok(iter) = line_iter.First() {
            while iter.HasCurrent().unwrap_or(false) {
                if let Ok(line) = iter.Current() {
                    if let Ok(t) = line.Text() {
                        lines.push(t.to_string_lossy());
                    }
                }
                if iter.MoveNext().is_err() {
                    break;
                }
            }
        }
    }
    let language = engine
        .RecognizerLanguage()
        .ok()
        .and_then(|l| l.LanguageTag().ok())
        .map(|t| t.to_string_lossy());

    Ok(OkResponse {
        ok: true,
        engine: engine_name(),
        text,
        lines,
        language,
    })
}

#[cfg(target_os = "macos")]
fn ocr(path: &Path) -> Result<OkResponse<'static>, String> {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{AnyThread, ClassType};
    use objc2_foundation::{NSArray, NSData, NSDictionary, NSError};
    use objc2_vision::{
        VNImageOption, VNImageRequestHandler, VNRecognizeTextRequest, VNRequest,
        VNRequestTextRecognitionLevel,
    };

    fn ns_error(label: &str, err: Retained<NSError>) -> String {
        format!("{label}: {}", err.localizedDescription().to_string())
    }

    let bytes = std::fs::read(path).map_err(|e| format!("read image: {e}"))?;
    let data = NSData::from_vec(bytes);
    let options = NSDictionary::<VNImageOption, AnyObject>::new();
    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    request.setUsesLanguageCorrection(true);
    request.setAutomaticallyDetectsLanguage(true);

    let request_ref: &VNRequest = request.as_super().as_super();
    let requests = NSArray::<VNRequest>::from_slice(&[request_ref]);
    let handler = VNImageRequestHandler::initWithData_options(
        VNImageRequestHandler::alloc(),
        &data,
        &options,
    );
    handler
        .performRequests_error(&requests)
        .map_err(|err| ns_error("perform text recognition", err))?;

    let Some(observations) = request.results() else {
        return Ok(OkResponse {
            ok: true,
            engine: engine_name(),
            text: String::new(),
            lines: Vec::new(),
            language: None,
        });
    };

    let mut lines = Vec::new();
    for i in 0..observations.count() {
        let observation = observations.objectAtIndex(i);
        let candidates = observation.topCandidates(1);
        let Some(candidate) = candidates.firstObject() else {
            continue;
        };
        let line = candidate.string().to_string().trim().to_string();
        if !line.is_empty() {
            lines.push(line);
        }
    }
    let text = lines.join("\n");

    Ok(OkResponse {
        ok: true,
        engine: engine_name(),
        text,
        lines,
        language: None,
    })
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn ocr(_path: &Path) -> Result<OkResponse<'static>, String> {
    Err("hpm-ocr native engine not implemented on this platform".into())
}

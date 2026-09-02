// Black-box integration tests for the hpm-embed sidecar.
//
// hpm-embed speaks newline-delimited JSON over stdio:
//   stdin   : { type: "init" | "embed" | "flush" | "shutdown", ... }
//   stdout  : { type: "status" | "ready" | "embedding" | "error" | "flushed" | ... }
//
// We split tests into two tiers:
//
//   1. Protocol-shape tests (always run). Spawn the binary, talk NDJSON, and
//      verify framing: invalid JSON yields an error event; embed-before-init
//      is an error; flush echoes its id; shutdown ends the conversation;
//      blank lines are ignored; EOF terminates the process cleanly. None of
//      these require a model — the binary returns "model not loaded" before
//      hf-hub or ONNX is touched.
//
//   2. End-to-end tests (gated on HPM_EMBED_E2E=1). These actually load a
//      model and produce vectors. They're opt-in because the first run
//      downloads ~80MB and needs an ONNX provider. CI doesn't set the env
//      var so these are skipped automatically.
//
// We use a reader-thread + channel so we can apply timeouts to ChildStdout
// (std doesn't offer a portable non-blocking read).

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_hpm-embed")
}

fn pipe_lines(stdout: ChildStdout) -> Receiver<String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    if tx.send(l).is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    });
    rx
}

fn next_line(rx: &Receiver<String>, timeout: Duration) -> Option<String> {
    match rx.recv_timeout(timeout) {
        Ok(line) => Some(line),
        Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => None,
    }
}

/// Drain the reader until we see a line matching `predicate`, or hit the
/// deadline. Returns the matching line. Used when other "noise" lines (like
/// `status` events emitted during init) may interleave with the one we care
/// about.
fn next_line_matching<F>(
    rx: &Receiver<String>,
    timeout: Duration,
    mut predicate: F,
) -> Option<String>
where
    F: FnMut(&str) -> bool,
{
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        match next_line(rx, remaining) {
            Some(line) if predicate(&line) => return Some(line),
            Some(_) => continue, // skip noise
            None => return None,
        }
    }
}

fn spawn() -> Child {
    Command::new(bin())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn hpm-embed")
}

fn wait_with_timeout(child: &mut Child, timeout: Duration) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            Ok(None) => return None,
            Err(_) => return None,
        }
    }
}

// ---- Tier 1: protocol-shape tests (always run) ---------------------------

#[test]
fn shutdown_request_emits_stopped_status_and_exits_cleanly() {
    let mut child = spawn();
    let stdout = child.stdout.take().expect("stdout");
    let rx = pipe_lines(stdout);

    let mut stdin = child.stdin.take().expect("stdin");
    writeln!(stdin, r#"{{"type":"shutdown"}}"#).expect("write shutdown");
    drop(stdin);

    let line = next_line(&rx, Duration::from_secs(5)).expect("status line");
    assert!(line.contains("\"type\":\"status\""), "got: {line}");
    assert!(line.contains("\"status\":\"stopped\""), "got: {line}");

    let status = wait_with_timeout(&mut child, Duration::from_secs(5))
        .expect("child should exit after shutdown");
    assert!(status.success(), "exit status: {status:?}");
}

#[test]
fn embed_before_init_returns_a_model_not_loaded_error_keyed_by_id() {
    let mut child = spawn();
    let stdout = child.stdout.take().expect("stdout");
    let rx = pipe_lines(stdout);

    let mut stdin = child.stdin.take().expect("stdin");
    writeln!(
        stdin,
        r#"{{"type":"embed","id":"req-7","kind":"query","text":"hello world"}}"#
    )
    .expect("write embed");

    let line = next_line(&rx, Duration::from_secs(5)).expect("error line");
    assert!(line.contains("\"type\":\"error\""), "got: {line}");
    assert!(
        line.contains("\"id\":\"req-7\""),
        "error should echo id, got: {line}"
    );
    assert!(line.contains("model not loaded"), "got: {line}");

    // Sidecar must remain responsive after the error.
    writeln!(stdin, r#"{{"type":"shutdown"}}"#).expect("write shutdown");
    drop(stdin);
    wait_with_timeout(&mut child, Duration::from_secs(5));
}

#[test]
fn malformed_json_emits_invalid_request_error_and_keeps_processing() {
    let mut child = spawn();
    let stdout = child.stdout.take().expect("stdout");
    let rx = pipe_lines(stdout);

    let mut stdin = child.stdin.take().expect("stdin");
    writeln!(stdin, "this is not json").expect("write garbage");

    let line = next_line(&rx, Duration::from_secs(5)).expect("error line");
    assert!(line.contains("\"type\":\"error\""), "got: {line}");
    assert!(line.contains("invalid request"), "got: {line}");

    // After the error the binary keeps reading: send an embed request and
    // expect another error (model not loaded), proving the loop continued.
    writeln!(stdin, r#"{{"type":"embed","id":"after-bad","text":"hi"}}"#).expect("write embed");
    let line2 = next_line(&rx, Duration::from_secs(5)).expect("second response");
    assert!(line2.contains("\"type\":\"error\""), "got: {line2}");
    assert!(line2.contains("\"id\":\"after-bad\""), "got: {line2}");

    writeln!(stdin, r#"{{"type":"shutdown"}}"#).expect("write shutdown");
    drop(stdin);
    wait_with_timeout(&mut child, Duration::from_secs(5));
}

#[test]
fn unknown_request_type_is_reported_as_invalid_request() {
    let mut child = spawn();
    let stdout = child.stdout.take().expect("stdout");
    let rx = pipe_lines(stdout);

    let mut stdin = child.stdin.take().expect("stdin");
    writeln!(stdin, r#"{{"type":"frobnicate"}}"#).expect("write");
    let line = next_line(&rx, Duration::from_secs(5)).expect("error line");
    assert!(line.contains("\"type\":\"error\""), "got: {line}");
    assert!(line.contains("invalid request"), "got: {line}");

    writeln!(stdin, r#"{{"type":"shutdown"}}"#).expect("shutdown");
    drop(stdin);
    wait_with_timeout(&mut child, Duration::from_secs(5));
}

#[test]
fn flush_echoes_its_id_without_a_model_loaded() {
    let mut child = spawn();
    let stdout = child.stdout.take().expect("stdout");
    let rx = pipe_lines(stdout);

    let mut stdin = child.stdin.take().expect("stdin");
    writeln!(stdin, r#"{{"type":"flush","id":"batch-1"}}"#).expect("flush");
    let line = next_line(&rx, Duration::from_secs(5)).expect("flushed line");
    assert!(line.contains("\"type\":\"flushed\""), "got: {line}");
    assert!(line.contains("\"id\":\"batch-1\""), "got: {line}");

    // Flush with no id is also valid.
    writeln!(stdin, r#"{{"type":"flush"}}"#).expect("flush no id");
    let line = next_line(&rx, Duration::from_secs(5)).expect("flushed line");
    assert!(line.contains("\"type\":\"flushed\""), "got: {line}");

    writeln!(stdin, r#"{{"type":"shutdown"}}"#).expect("shutdown");
    drop(stdin);
    wait_with_timeout(&mut child, Duration::from_secs(5));
}

#[test]
fn blank_and_whitespace_only_lines_produce_no_response() {
    let mut child = spawn();
    let stdout = child.stdout.take().expect("stdout");
    let rx = pipe_lines(stdout);

    let mut stdin = child.stdin.take().expect("stdin");
    writeln!(stdin).expect("blank");
    writeln!(stdin, "   \t  ").expect("whitespace");

    // No response within 300ms.
    assert!(
        next_line(&rx, Duration::from_millis(300)).is_none(),
        "blank lines should be silently skipped",
    );

    // After the no-ops, a real request still works.
    writeln!(stdin, r#"{{"type":"flush","id":"x"}}"#).expect("flush");
    let line = next_line(&rx, Duration::from_secs(5)).expect("flushed");
    assert!(line.contains("\"type\":\"flushed\""), "got: {line}");

    writeln!(stdin, r#"{{"type":"shutdown"}}"#).expect("shutdown");
    drop(stdin);
    wait_with_timeout(&mut child, Duration::from_secs(5));
}

#[test]
fn eof_on_stdin_terminates_the_process_without_an_explicit_shutdown() {
    let mut child = spawn();
    // Drop stdin immediately to signal EOF.
    drop(child.stdin.take());

    let status =
        wait_with_timeout(&mut child, Duration::from_secs(5)).expect("child should exit on EOF");
    assert!(status.success(), "exit status: {status:?}");
}

#[test]
fn requests_are_processed_in_order_each_carrying_its_own_id() {
    let mut child = spawn();
    let stdout = child.stdout.take().expect("stdout");
    let rx = pipe_lines(stdout);

    let mut stdin = child.stdin.take().expect("stdin");
    for id in ["a", "b", "c"] {
        writeln!(stdin, r#"{{"type":"embed","id":"{id}","text":"x"}}"#).expect("write embed");
    }

    // Expect three error events (model not loaded), in order.
    let mut seen = Vec::new();
    for _ in 0..3 {
        let line = next_line(&rx, Duration::from_secs(5)).expect("error line");
        assert!(line.contains("\"type\":\"error\""), "got: {line}");
        for id in ["a", "b", "c"] {
            if line.contains(&format!("\"id\":\"{id}\"")) {
                seen.push(id);
                break;
            }
        }
    }
    assert_eq!(
        seen,
        vec!["a", "b", "c"],
        "responses should preserve request order"
    );

    writeln!(stdin, r#"{{"type":"shutdown"}}"#).expect("shutdown");
    drop(stdin);
    wait_with_timeout(&mut child, Duration::from_secs(5));
}

// ---- Tier 2: end-to-end tests (HPM_EMBED_E2E=1) --------------------------

/// Whether to run the model-loading tests. Off by default — the first run
/// downloads ~80MB and CI runners typically don't keep that cached.
fn e2e_enabled() -> bool {
    std::env::var("HPM_EMBED_E2E").ok().as_deref() == Some("1")
}

#[test]
fn e2e_init_then_embed_returns_normalized_vector() {
    if !e2e_enabled() {
        eprintln!("HPM_EMBED_E2E != 1; skipping e2e");
        return;
    }
    let mut child = spawn();
    let stdout = child.stdout.take().expect("stdout");
    let rx = pipe_lines(stdout);

    let mut stdin = child.stdin.take().expect("stdin");
    writeln!(stdin, r#"{{"type":"init"}}"#).expect("init");

    // ready may come after a few status events; wait up to 120s for the
    // first run (download time dominates).
    let ready = next_line_matching(&rx, Duration::from_secs(120), |line| {
        line.contains("\"type\":\"ready\"")
    })
    .expect("ready event within 120s");
    assert!(ready.contains("\"dim\":384"), "got: {ready}");

    writeln!(
        stdin,
        r#"{{"type":"embed","id":"hi","kind":"query","text":"hello"}}"#
    )
    .expect("embed");
    let emb = next_line_matching(&rx, Duration::from_secs(30), |line| {
        line.contains("\"type\":\"embedding\"")
    })
    .expect("embedding line");
    assert!(emb.contains("\"id\":\"hi\""), "got: {emb}");

    // Parse the vector out and verify L2 norm ≈ 1.
    let parsed: serde_json::Value = serde_json::from_str(&emb).expect("parse json");
    let vec = parsed
        .get("vector")
        .and_then(|v| v.as_array())
        .expect("vector array");
    assert_eq!(vec.len(), 384, "expected 384-dim vector");
    let norm = vec
        .iter()
        .map(|v| {
            let f = v.as_f64().unwrap();
            f * f
        })
        .sum::<f64>()
        .sqrt();
    assert!(
        (norm - 1.0).abs() < 1e-3,
        "L2 norm should be ~1.0, got {norm}"
    );

    writeln!(stdin, r#"{{"type":"shutdown"}}"#).expect("shutdown");
    drop(stdin);
    wait_with_timeout(&mut child, Duration::from_secs(10));
}

#[test]
fn e2e_batch_of_embeds_returns_results_in_request_order() {
    if !e2e_enabled() {
        eprintln!("HPM_EMBED_E2E != 1; skipping e2e");
        return;
    }
    let mut child = spawn();
    let stdout = child.stdout.take().expect("stdout");
    let rx = pipe_lines(stdout);

    let mut stdin = child.stdin.take().expect("stdin");
    writeln!(stdin, r#"{{"type":"init"}}"#).expect("init");
    next_line_matching(&rx, Duration::from_secs(120), |line| {
        line.contains("\"type\":\"ready\"")
    })
    .expect("ready");

    let ids = ["a", "b", "c", "d"];
    for id in ids {
        writeln!(
            stdin,
            r#"{{"type":"embed","id":"{id}","text":"{id} something to encode"}}"#
        )
        .expect("write embed");
    }

    let mut order = Vec::new();
    for _ in 0..ids.len() {
        let line = next_line_matching(&rx, Duration::from_secs(30), |line| {
            line.contains("\"type\":\"embedding\"")
        })
        .expect("embedding line");
        for id in ids {
            if line.contains(&format!("\"id\":\"{id}\"")) {
                order.push(id);
                break;
            }
        }
    }
    assert_eq!(order, ids.to_vec(), "embeddings should come back in order");

    writeln!(stdin, r#"{{"type":"shutdown"}}"#).expect("shutdown");
    drop(stdin);
    wait_with_timeout(&mut child, Duration::from_secs(10));
}

#[test]
fn e2e_unknown_model_emits_an_error_not_a_ready() {
    if !e2e_enabled() {
        eprintln!("HPM_EMBED_E2E != 1; skipping e2e");
        return;
    }
    let mut child = spawn();
    let stdout = child.stdout.take().expect("stdout");
    let rx = pipe_lines(stdout);

    let mut stdin = child.stdin.take().expect("stdin");
    // Slash-form repo that hf-hub will try to fetch, but doesn't exist.
    writeln!(
        stdin,
        r#"{{"type":"init","model":"this-org/does-not-exist-zzz"}}"#
    )
    .expect("init bad");

    let err = next_line_matching(&rx, Duration::from_secs(60), |line| {
        line.contains("\"type\":\"error\"")
    })
    .expect("error event");
    assert!(err.contains("embedding model failed"), "got: {err}");

    // After the failure the worker remains in "no model loaded" state.
    writeln!(stdin, r#"{{"type":"embed","id":"after","text":"hi"}}"#).expect("embed");
    let line = next_line_matching(&rx, Duration::from_secs(5), |line| {
        line.contains("\"type\":\"error\"") && line.contains("\"id\":\"after\"")
    })
    .expect("model-not-loaded error");
    assert!(line.contains("model not loaded"), "got: {line}");

    writeln!(stdin, r#"{{"type":"shutdown"}}"#).expect("shutdown");
    drop(stdin);
    wait_with_timeout(&mut child, Duration::from_secs(10));
}

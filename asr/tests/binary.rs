use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_hpm-asr")
}

fn pipe_lines(stdout: ChildStdout) -> Receiver<String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if tx.send(line).is_err() {
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

fn spawn() -> Child {
    Command::new(bin())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn hpm-asr")
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
fn malformed_json_emits_invalid_request_error_and_keeps_processing() {
    let mut child = spawn();
    let stdout = child.stdout.take().expect("stdout");
    let rx = pipe_lines(stdout);

    let mut stdin = child.stdin.take().expect("stdin");
    writeln!(stdin, "not json").expect("write malformed json");

    let line = next_line(&rx, Duration::from_secs(5)).expect("error line");
    assert!(line.contains("\"type\":\"error\""), "got: {line}");
    assert!(line.contains("invalid request"), "got: {line}");

    writeln!(stdin, r#"{{"type":"flush","id":"after-bad"}}"#).expect("write flush");
    let line2 = next_line(&rx, Duration::from_secs(5)).expect("flushed line");
    assert!(line2.contains("\"type\":\"flushed\""), "got: {line2}");
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
    writeln!(stdin, r#"{{"type":"frobnicate"}}"#).expect("write unknown request");
    let line = next_line(&rx, Duration::from_secs(5)).expect("error line");
    assert!(line.contains("\"type\":\"error\""), "got: {line}");
    assert!(line.contains("invalid request"), "got: {line}");

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

    assert!(
        next_line(&rx, Duration::from_millis(300)).is_none(),
        "blank lines should be skipped silently",
    );

    writeln!(stdin, r#"{{"type":"flush","id":"x"}}"#).expect("flush");
    let line = next_line(&rx, Duration::from_secs(5)).expect("flushed line");
    assert!(line.contains("\"type\":\"flushed\""), "got: {line}");
    assert!(line.contains("\"id\":\"x\""), "got: {line}");

    writeln!(stdin, r#"{{"type":"shutdown"}}"#).expect("shutdown");
    drop(stdin);
    wait_with_timeout(&mut child, Duration::from_secs(5));
}

#[test]
fn eof_on_stdin_terminates_the_process_without_shutdown() {
    let mut child = spawn();
    drop(child.stdin.take());

    let status =
        wait_with_timeout(&mut child, Duration::from_secs(5)).expect("child should exit on EOF");
    assert!(status.success(), "exit status: {status:?}");
}

#[test]
fn flush_requests_are_processed_in_order_each_carrying_its_id() {
    let mut child = spawn();
    let stdout = child.stdout.take().expect("stdout");
    let rx = pipe_lines(stdout);

    let mut stdin = child.stdin.take().expect("stdin");
    for id in ["a", "b", "c"] {
        writeln!(stdin, r#"{{"type":"flush","id":"{id}"}}"#).expect("write flush");
    }

    let mut seen = Vec::new();
    for _ in 0..3 {
        let line = next_line(&rx, Duration::from_secs(5)).expect("flushed line");
        assert!(line.contains("\"type\":\"flushed\""), "got: {line}");
        for id in ["a", "b", "c"] {
            if line.contains(&format!("\"id\":\"{id}\"")) {
                seen.push(id);
                break;
            }
        }
    }
    assert_eq!(seen, vec!["a", "b", "c"]);

    writeln!(stdin, r#"{{"type":"shutdown"}}"#).expect("shutdown");
    drop(stdin);
    wait_with_timeout(&mut child, Duration::from_secs(5));
}

#[test]
fn audio_before_model_ready_is_dropped_silently_but_worker_stays_responsive() {
    let mut child = spawn();
    let stdout = child.stdout.take().expect("stdout");
    let rx = pipe_lines(stdout);

    let mut stdin = child.stdin.take().expect("stdin");
    writeln!(
        stdin,
        r#"{{"type":"audio","source":"mic","chunk_id":"chunk-1","at":1,"sample_rate":16000,"pcm_b64":""}}"#
    )
    .expect("write audio");

    assert!(
        next_line(&rx, Duration::from_millis(300)).is_none(),
        "audio before init/model-ready should not emit noisy errors",
    );

    writeln!(stdin, r#"{{"type":"flush","id":"after-audio"}}"#).expect("flush");
    let line = next_line(&rx, Duration::from_secs(5)).expect("flushed line");
    assert!(line.contains("\"type\":\"flushed\""), "got: {line}");
    assert!(line.contains("\"id\":\"after-audio\""), "got: {line}");

    writeln!(stdin, r#"{{"type":"shutdown"}}"#).expect("shutdown");
    drop(stdin);
    wait_with_timeout(&mut child, Duration::from_secs(5));
}

mod support;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use suppai::core::acp::AcpClient;

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/fake-cli.mjs")
}

fn start(home: &Path, cwd: &Path) -> AcpClient {
    let fixture = fixture();
    AcpClient::spawn(
        "node",
        &[fixture.to_string_lossy().as_ref()],
        cwd,
        home,
        &[("FAKE_CLI_NO_LOAD", "0"), ("FAKE_CLI_NO_LIST", "0"), ("FAKE_CLI_LIST_FAIL", "0")],
    )
    .unwrap()
}

fn initialize(client: &AcpClient) -> Value {
    client
        .request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {},
                "clientInfo": { "name": "suppai", "version": "0.1.0" }
            }),
        )
        .unwrap()
}

fn prompt(client: &AcpClient, session: &str, text: &str) -> Value {
    client
        .request(
            "session/prompt",
            json!({ "sessionId": session, "prompt": [{ "type": "text", "text": text }] }),
        )
        .unwrap()
}

#[test]
fn initialize_prompt_and_list_against_the_synthetic_cli() {
    let home = support::tempdir();
    let cwd = support::tempdir();
    let client = start(&home, &cwd);
    let init = initialize(&client);
    assert_eq!(init["agentCapabilities"]["loadSession"], true);
    assert!(init["sessionCapabilities"]["list"].is_object());

    let session = client.request("session/new", json!({ "cwd": cwd, "mcpServers": [] })).unwrap();
    let session_id = session["sessionId"].as_str().unwrap();
    let result = prompt(&client, session_id, "hello synthetic");
    assert_eq!(result["stopReason"], "end_turn");

    let list = client
        .request("session/list", json!({ "cwd": cwd }))
        .unwrap();
    assert_eq!(list["sessions"].as_array().unwrap().len(), 1);
}

#[test]
fn notifications_and_permission_requests_reach_their_handlers() {
    let home = support::tempdir();
    let cwd = support::tempdir();
    let client = start(&home, &cwd);
    initialize(&client);
    let session = client.request("session/new", json!({ "cwd": cwd, "mcpServers": [] })).unwrap();
    let session_id = session["sessionId"].as_str().unwrap().to_string();

    let seen = Arc::new(Mutex::new(String::new()));
    let sink = seen.clone();
    client.on_notification(Box::new(move |message: Value| {
        if let Some(text) = message["params"]["update"]["content"]["text"].as_str() {
            sink.lock().unwrap().push_str(text);
        }
    }));
    client.on_permission(Box::new(|_| {
        json!({ "outcome": { "outcome": "selected", "optionId": "allow_once" } })
    }));

    prompt(&client, &session_id, "[EXTERNAL] run it");
    let text = seen.lock().unwrap().clone();
    assert!(text.contains("Permission selected: allow_once"), "got {text}");
}

#[test]
fn a_crashed_child_fails_pending_requests() {
    let home = support::tempdir();
    let cwd = support::tempdir();
    let client = start(&home, &cwd);
    initialize(&client);
    let session = client.request("session/new", json!({ "cwd": cwd, "mcpServers": [] })).unwrap();
    let error = client
        .request_timeout(
            "session/prompt",
            json!({ "sessionId": session["sessionId"], "prompt": [{ "type": "text", "text": "[FAIL]" }] }),
            Duration::from_secs(10),
        )
        .unwrap_err();
    assert_eq!(error.code, "CLI");
}

mod support;

use suppai::core::history::{History, load_history, save_history};

#[test]
fn a_missing_file_loads_empty() {
    let dir = support::tempdir();
    assert_eq!(load_history(&dir.join("history.json")).unwrap(), History::default());
}

#[test]
fn an_electron_history_loads_with_titles_and_sessions() {
    let dir = support::tempdir();
    let path = dir.join("history.json");
    std::fs::write(
        &path,
        r#"{
          "conversations": [
            {
              "id": "c1",
              "createdAt": "2026-11-01T10:00:00.000Z",
              "title": "Attached session",
              "sessionId": "s-1",
              "messages": [
                { "id": "m1", "role": "user", "text": "hello" },
                { "id": "m2", "role": "agent", "text": "hi" }
              ]
            }
          ],
          "currentId": "c1"
        }"#,
    )
    .unwrap();
    let history = load_history(&path).unwrap();
    assert_eq!(history.conversations.len(), 1);
    assert_eq!(history.conversations[0].title.as_deref(), Some("Attached session"));
    assert_eq!(history.conversations[0].session_id.as_deref(), Some("s-1"));
    assert_eq!(history.current().unwrap().messages.len(), 2);
}

#[test]
fn a_bad_title_or_role_is_a_state_error() {
    let dir = support::tempdir();
    let path = dir.join("history.json");
    std::fs::write(&path, r#"{"conversations":[{"id":"c1","createdAt":"x","title":5,"messages":[]}]}"#).unwrap();
    assert_eq!(load_history(&path).unwrap_err().code, "STATE");
    std::fs::write(&path, r#"{"conversations":[{"id":"c1","createdAt":"x","messages":[{"id":"m","role":"narrator","text":"x"}]}]}"#).unwrap();
    assert_eq!(load_history(&path).unwrap_err().code, "STATE");
}

#[test]
fn a_current_id_must_exist() {
    let dir = support::tempdir();
    let path = dir.join("history.json");
    std::fs::write(&path, r#"{"conversations":[],"currentId":"missing"}"#).unwrap();
    assert_eq!(load_history(&path).unwrap_err().code, "STATE");
}

#[test]
fn saving_preserves_unknown_keys() {
    let dir = support::tempdir();
    let path = dir.join("history.json");
    std::fs::write(&path, r#"{"conversations":[],"currentId":null,"future":{"keep":true}}"#).unwrap();
    let mut history = load_history(&path).unwrap();
    history.current_id = None;
    save_history(&path, &history).unwrap();
    let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(raw["future"]["keep"], true);
    assert_eq!(raw["currentId"], serde_json::Value::Null);
}

#[test]
fn saving_over_a_corrupt_file_is_refused() {
    let dir = support::tempdir();
    let path = dir.join("history.json");
    std::fs::write(&path, "{ nope").unwrap();
    assert!(save_history(&path, &History::default()).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ nope");
}

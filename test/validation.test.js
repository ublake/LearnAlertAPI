import test from "node:test";
import assert from "node:assert/strict";

import {
  validateGenerateForm,
  validateGenerateRequest,
  ValidationError
} from "../src/lib/validation.js";

test("accepts all card types and chat history in JSON generation", () => {
  const config = validateGenerateRequest({
    text: "Study notes",
    preferredCardTypes: [
      "tap_reveal",
      "multiple_choice",
      "matching",
      "fill_blank"
    ],
    chatHistory: [
      { role: "user", content: " Create Spanish cards. " },
      { role: "assistant", content: "Send your notes." },
      { role: "system", content: "ignored" }
    ]
  });

  assert.deepEqual(config.preferredCardTypes, [
    "tap_reveal",
    "multiple_choice",
    "matching",
    "fill_blank"
  ]);
  assert.deepEqual(config.chatHistory, [
    { role: "user", content: "Create Spanish cards." },
    { role: "assistant", content: "Send your notes." }
  ]);
});

test("parses chat history as JSON in multipart generation", () => {
  const formData = new FormData();
  formData.set(
    "file",
    new File(["hola = hello"], "spanish.txt", { type: "text/plain" })
  );
  formData.set(
    "preferredCardTypes",
    JSON.stringify(["matching", "fill_blank"])
  );
  formData.set(
    "chatHistory",
    JSON.stringify([
      { role: "user", content: "Create Spanish vocabulary cards." },
      { role: "assistant", content: "Send your vocabulary notes." }
    ])
  );

  const config = validateGenerateForm(formData);

  assert.deepEqual(config.preferredCardTypes, ["matching", "fill_blank"]);
  assert.deepEqual(config.chatHistory, [
    { role: "user", content: "Create Spanish vocabulary cards." },
    { role: "assistant", content: "Send your vocabulary notes." }
  ]);
});

test("rejects malformed multipart chat history", () => {
  const formData = new FormData();
  formData.set(
    "file",
    new File(["notes"], "notes.txt", { type: "text/plain" })
  );
  formData.set("chatHistory", "not-json");

  assert.throws(
    () => validateGenerateForm(formData),
    (error) =>
      error instanceof ValidationError &&
      error.message === "chatHistory must be a valid JSON array."
  );
});

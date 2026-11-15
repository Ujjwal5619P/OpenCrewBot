import assert from "node:assert/strict";
import { test } from "node:test";
import { instantReplyForMessage, isGitHubRepositoryListRequest } from "../src/lib/server/github-request.ts";

test("recognizes direct GitHub repository listing requests", () => {
  assert.equal(isGitHubRepositoryListRequest("List all my GitHub repositories"), true);
  assert.equal(isGitHubRepositoryListRequest("list all my github repo's"), true);
  assert.equal(isGitHubRepositoryListRequest("Show every repository owned by my connected GitHub account, including private ones"), true);
  assert.equal(isGitHubRepositoryListRequest("Fetch my repos"), true);
  assert.equal(isGitHubRepositoryListRequest("/no_think List all my GitHub repositories."), true);
});

test("does not bypass the agent for analysis or unrelated repository questions", () => {
  assert.equal(isGitHubRepositoryListRequest("Analyze my GitHub repositories"), false);
  assert.equal(isGitHubRepositoryListRequest("Explain how GitHub repositories work"), false);
  assert.equal(isGitHubRepositoryListRequest("List repositories from this JSON file"), false);
  assert.equal(isGitHubRepositoryListRequest("List all my GitHub repositories. " + "context ".repeat(100)), false);
});


test("handles simple greetings without invoking the LLM", () => {
  assert.equal(instantReplyForMessage("hi"), "Hi! How can I help you?");
  assert.equal(instantReplyForMessage("Hello!"), "Hi! How can I help you?");
  assert.equal(instantReplyForMessage("/no_think good morning"), "Hi! How can I help you?");
  assert.equal(instantReplyForMessage("thanks"), "You're welcome!");
  assert.equal(instantReplyForMessage("bye"), "Goodbye!");
  assert.equal(instantReplyForMessage("hi, can you list my repos?"), null);
  assert.equal(instantReplyForMessage("help me debug this"), null);
});

/** True only for straightforward requests to list the connected GitHub repositories. */
export function isGitHubRepositoryListRequest(content: string): boolean {
  const value = content.toLowerCase().replace(/\s+/g, " ").trim();
  if (!value || value.length > 400 || /\b(analy[sz]e|summari[sz]e|explain|compare|classify|review|audit|investigate)\b/.test(value)) return false;
  const listIntent = /\b(list|show|display|fetch|get|retrieve)\b/.test(value);
  const repositoryTarget = /\b(repositories|repository|repos|repo)\b/.test(value);
  const githubContext = /\b(github|git hub|connected account|my account|my repos|my repositories)\b/.test(value);
  return listIntent && repositoryTarget && githubContext;
}


/** Short social messages that should not start an agent/model turn. */
export function instantReplyForMessage(content: string): string | null {
  const value = content
    .replace(/^\s*\/no_think\s*/i, "")
    .toLowerCase()
    .replace(/[.!?,。！？]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (/^(hi|hello|hey|hiya|yo|good morning|good afternoon|good evening)$/.test(value)) {
    return "Hi! How can I help you?";
  }
  if (/^(thanks|thank you|thx|ty)$/.test(value)) {
    return "You're welcome!";
  }
  if (/^(bye|goodbye|see you)$/.test(value)) {
    return "Goodbye!";
  }
  return null;
}

/**
 * Word-aware job title matcher shared by extension pages and site tabs.
 * Plain script (no import/export) so it can be injected via
 * chrome.scripting.executeScript({ files }) and also imported for side effects.
 */
(function () {
  const PHRASES = [
    [/\bfront end\b/g, "frontend"],
    [/\bback end\b/g, "backend"],
    [/\bfull stack\b/g, "fullstack"],
    [/\bdev ops\b/g, "devops"],
    [/\bartificial intelligence\b/g, "ai"],
    [/\bmachine learning\b/g, "ml"],
    [/\b(react|node|vue|next|nest|express|angular)(?: ?js)\b/g, "$1"],
    [/\bgolang\b/g, "go"],
  ];

  const WORDS = {
    sr: "senior",
    snr: "senior",
    jr: "junior",
    eng: "engineer",
    engr: "engineer",
    dev: "developer",
    swe: "software engineer",
    postgresql: "postgres",
    k8s: "kubernetes",
    dotnet: "net",
  };

  function normalize(text) {
    let s = String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9+#]+/g, " ")
      .trim();
    s = s
      .split(" ")
      .map((w) => WORDS[w] || w)
      .join(" ");
    for (const [re, rep] of PHRASES) s = s.replace(re, rep);
    return s.replace(/\s+/g, " ").trim();
  }

  function queryTokens(query) {
    const s = normalize(query);
    if (!s) return [];
    return s
      .split(" ")
      .filter((t) => t.length > 1 || /[+#]/.test(t));
  }

  function tokenInWords(token, words) {
    for (const w of words) {
      if (w === token) return true;
      // engineer → engineering, develop → developer
      if (token.length >= 4 && w.startsWith(token)) return true;
    }
    return false;
  }

  function jbTitleMatches(title, query) {
    const tokens = queryTokens(query);
    if (!tokens.length) return true;
    const words = normalize(title).split(" ");
    return tokens.every((t) => tokenInWords(t, words));
  }

  /**
   * Every stack word must appear as a whole word in the title or description
   * (Go ≠ Google, Java ≠ JavaScript, Node.js = NodeJS = Node).
   */
  function jbStackMatches(job, stack) {
    const tokens = queryTokens(stack);
    if (!tokens.length) return true;
    const words = new Set(
      normalize(`${job?.title || ""} ${job?.description || ""}`).split(" ")
    );
    return tokens.every((t) => words.has(t));
  }

  globalThis.jbTitleMatches = jbTitleMatches;
  globalThis.jbTitleQueryTokens = queryTokens;
  globalThis.jbStackMatches = jbStackMatches;
})();

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
    [/\b(react|node|vue|angular)(?: ?js)\b/g, "$1"],
    // Next/Nest/Express are everyday words: keep the .js form distinct
    [/\b(next|nest|express)(?: ?js)\b/g, "$1js"],
    [/\bobjective c\b/g, "objectivec"],
    // ".NET" and "dotnet" become "dotnet" in normalize(); staffing ads say "Dot Net"
    [/\bdot net\b/g, "dotnet"],
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
    springboot: "spring boot",
  };

  function normalize(text) {
    let s = String(text || "")
      .toLowerCase()
      // ".NET" / "ASP.NET" before punctuation goes ("net" alone is a word)
      .replace(/\.net\b/g, " dotnet")
      // "React+Redux" is two words; "C++" stays one
      .replace(/([a-z])\+(?=[a-z])/g, "$1 ")
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
    // "Python3", "C++17": the word plus a version number
    const versioned = (t) =>
      [...words].some((w) => w.startsWith(t) && /^\d+$/.test(w.slice(t.length)));
    // A bare "Express" asks for the framework too ("Express.js" → expressjs);
    // a "Next.js" query still needs the .js form
    const jsForm = (t) => /^(?:next|nest|express)$/.test(t) && words.has(`${t}js`);
    return tokens.every((t) => words.has(t) || versioned(t) || jsForm(t));
  }

  globalThis.jbTitleMatches = jbTitleMatches;
  globalThis.jbTitleQueryTokens = queryTokens;
  /** All normalized words, 1-letter ones included ("C Developer" → c, developer). */
  globalThis.jbNormalizeWords = (text) => normalize(text).split(" ").filter(Boolean);
  globalThis.jbStackMatches = jbStackMatches;
})();

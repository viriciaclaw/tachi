const THREAT_PATTERNS = [
  {
    pattern: "ignore (all )?previous instructions",
    severity: "high",
    regex: /\bignore\s+(?:all\s+)?previous\s+instructions\b/gi,
  },
  {
    pattern: "ignore (all )?(prior|above) (instructions|prompts|rules)",
    severity: "high",
    regex: /\bignore\s+(?:all\s+)?(?:prior|above)\s+(?:instructions|prompts|rules)\b/gi,
  },
  {
    pattern: "you are now",
    severity: "high",
    regex: /\byou\s+are\s+now\b/gi,
  },
  {
    pattern: "^system:|\\nsystem:",
    severity: "high",
    regex: /(?:^|\s)system\s*:/gi,
  },
  {
    pattern: "new instructions:",
    severity: "high",
    regex: /\bnew\s+instructions\s*:/gi,
  },
  {
    pattern: "override (all )?safety",
    severity: "high",
    regex: /\boverride\s+(?:all\s+)?safety\b/gi,
  },
  {
    pattern: "eval\\(",
    severity: "medium",
    regex: /eval\(/gi,
  },
  {
    pattern: "exec\\(",
    severity: "medium",
    regex: /exec\(/gi,
  },
  {
    pattern: "os\\.system\\(",
    severity: "medium",
    regex: /os\.system\(/gi,
  },
  {
    pattern: "subprocess\\.",
    severity: "medium",
    regex: /subprocess\./gi,
  },
  {
    pattern: "child_process",
    severity: "medium",
    regex: /child_process/gi,
  },
  {
    pattern: "\\bcurl\\b.*http",
    severity: "medium",
    regex: /\bcurl\b.*http/gi,
  },
  {
    pattern: "\\bwget\\b.*http",
    severity: "medium",
    regex: /\bwget\b.*http/gi,
  },
  {
    pattern: "import os",
    severity: "medium",
    regex: /\bimport\s+os\b/gi,
  },
  {
    pattern: "require\\(['\"](child_process|fs|net|http)['\"]",
    severity: "medium",
    regex: /require\(['"](child_process|fs|net|http)['"]/gi,
  },
  {
    pattern: "as an admin",
    severity: "low",
    regex: /\bas\s+an\s+admin\b/gi,
  },
  {
    pattern: "with root access",
    severity: "low",
    regex: /\bwith\s+root\s+access\b/gi,
  },
  {
    pattern: "with sudo",
    severity: "low",
    regex: /\bwith\s+sudo\b/gi,
  },
  {
    pattern: "pretend you are",
    severity: "low",
    regex: /\bpretend\s+you\s+are\b/gi,
  },
  {
    pattern: "act as if you are",
    severity: "low",
    regex: /\bact\s+as\s+if\s+you\s+are\b/gi,
  },
  {
    pattern: "do not follow",
    severity: "low",
    regex: /\bdo\s+not\s+follow\b/gi,
  },
  {
    pattern: "disregard",
    severity: "low",
    regex: /\bdisregard\b/gi,
  },
];

function normalizeForDetection(text) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\r\n/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectInjection(text) {
  if (!text) {
    return { safe: true, threats: [] };
  }

  const normalizedText = normalizeForDetection(String(text));
  const threats = [];

  for (const threatPattern of THREAT_PATTERNS) {
    let match;
    while ((match = threatPattern.regex.exec(normalizedText)) !== null) {
      threats.push({
        pattern: threatPattern.pattern,
        severity: threatPattern.severity,
        match: match[0],
      });
    }
    threatPattern.regex.lastIndex = 0;
  }

  return {
    safe: threats.length === 0,
    threats,
  };
}

module.exports = {
  detectInjection,
  normalizeForDetection,
};

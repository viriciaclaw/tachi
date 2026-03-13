const THREAT_PATTERNS = [
  {
    pattern: "ignore (all )?previous instructions",
    severity: "high",
    regex: /ignore (all )?previous instructions/gi,
  },
  {
    pattern: "ignore (all )?(prior|above) (instructions|prompts|rules)",
    severity: "high",
    regex: /ignore (all )?(prior|above) (instructions|prompts|rules)/gi,
  },
  {
    pattern: "you are now",
    severity: "high",
    regex: /you are now/gi,
  },
  {
    pattern: "^system:|\\nsystem:",
    severity: "high",
    regex: /(^|\n)system:/gim,
  },
  {
    pattern: "new instructions:",
    severity: "high",
    regex: /new instructions:/gi,
  },
  {
    pattern: "override (all )?safety",
    severity: "high",
    regex: /override (all )?safety/gi,
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
    regex: /import os/gi,
  },
  {
    pattern: "require\\(['\"](child_process|fs|net|http)['\"]",
    severity: "medium",
    regex: /require\(['"](child_process|fs|net|http)['"]/gi,
  },
  {
    pattern: "as an admin",
    severity: "low",
    regex: /as an admin/gi,
  },
  {
    pattern: "with root access",
    severity: "low",
    regex: /with root access/gi,
  },
  {
    pattern: "with sudo",
    severity: "low",
    regex: /with sudo/gi,
  },
  {
    pattern: "pretend you are",
    severity: "low",
    regex: /pretend you are/gi,
  },
  {
    pattern: "act as if you are",
    severity: "low",
    regex: /act as if you are/gi,
  },
  {
    pattern: "do not follow",
    severity: "low",
    regex: /do not follow/gi,
  },
  {
    pattern: "disregard",
    severity: "low",
    regex: /disregard/gi,
  },
];

function detectInjection(text) {
  if (!text) {
    return { safe: true, threats: [] };
  }

  const threats = [];

  for (const threatPattern of THREAT_PATTERNS) {
    let match;
    while ((match = threatPattern.regex.exec(text)) !== null) {
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
};

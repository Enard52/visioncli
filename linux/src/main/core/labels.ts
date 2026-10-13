// Labels and choices shown in the tray menu. Port of overlay/Sources/CoreLabels.swift.

export const MenuLabels = {
  /** Claude Code model aliases (`claude --model <alias>`), so new versions are picked up without an app update. */
  claudeModels: [
    ["default", "Default (your Claude Code setting)"],
    ["fable", "Fable (most capable)"],
    ["opus", "Opus (deep reasoning)"],
    ["sonnet", "Sonnet (fast, balanced)"],
    ["haiku", "Haiku (fastest, cheapest)"],
    ["opusplan", "Opus to plan, Sonnet to do"],
    ["fable[1m]", "Fable, 1M context"],
    ["opus[1m]", "Opus, 1M context"],
    ["sonnet[1m]", "Sonnet, 1M context"],
  ] as ReadonlyArray<readonly [string, string]>,

  claudeModel(alias: string): string {
    const m = MenuLabels.claudeModels.find(([a]) => a === alias);
    return m ? m[1].split(" (")[0] : alias;
  },

  effort(level: string | null | undefined): string {
    switch (level) {
      case "low": return "Low (fastest)";
      case "medium": return "Medium";
      case "high": return "High";
      case "xhigh": return "Extra High";
      case "max": return "Max (slowest)";
      default: return "Default";
    }
  },

  /** The terminal's Claude switched models itself (/model there): the menu alias to follow, or null to keep the
   *  menu as is. `used` is the full model id from the transcript ("claude-opus-4-…"); a 1M-context menu choice
   *  counts as its family, and "opusplan" already covers Opus and Sonnet. */
  followedModel(used: string, menu: string): string | null {
    const family = ["fable", "opus", "sonnet", "haiku"].find((f) => used.includes(f));
    const current = menu.split("[1m]").join("");
    if (!family || current === family || (current === "opusplan" && (family === "opus" || family === "sonnet"))) return null;
    return family;
  },
};

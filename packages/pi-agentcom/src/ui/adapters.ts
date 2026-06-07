export interface ThemeLike {
  fg(name: string, text: string): string;
  bold(text: string): string;
}

export interface KeybindingsLike {
  matches(data: string, action: string): boolean;
  getKeys(action: string): string[];
}

export interface TuiLike {
  requestRender(): void;
}

export function defaultTheme(theme?: unknown): ThemeLike {
  const candidate = theme as Partial<ThemeLike> | undefined;
  return {
    fg: typeof candidate?.fg === "function" ? candidate.fg.bind(candidate) : (_name, text) => text,
    bold: typeof candidate?.bold === "function" ? candidate.bold.bind(candidate) : (text) => text,
  };
}

export function defaultKeybindings(keybindings?: unknown): KeybindingsLike {
  const candidate = keybindings as Partial<KeybindingsLike> | undefined;
  return {
    matches: typeof candidate?.matches === "function" ? candidate.matches.bind(candidate) : (data, action) => {
      if (action === "tui.select.cancel") return data === "\u001b";
      if (action === "tui.select.confirm") return data === "\r" || data === "\n";
      if (action === "tui.select.up") return data === "\u001b[A";
      if (action === "tui.select.down") return data === "\u001b[B";
      if (action === "tui.editor.deleteCharBackward") return data === "\b" || data === "\u007f";
      return false;
    },
    getKeys: typeof candidate?.getKeys === "function" ? candidate.getKeys.bind(candidate) : (action) => {
      if (action === "tui.select.cancel") return ["Esc"];
      if (action === "tui.select.confirm") return ["Enter"];
      return [];
    },
  };
}

export function defaultTui(tui?: unknown): TuiLike {
  return isTuiLike(tui) ? tui : { requestRender() {} };
}

function isTuiLike(value: unknown): value is TuiLike {
  return typeof value === "object" && value !== null && typeof (value as TuiLike).requestRender === "function";
}

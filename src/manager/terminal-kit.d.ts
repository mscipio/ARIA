// Minimal typings for the parts of terminal-kit the manager uses (the package ships none).
declare module "terminal-kit" {
  export interface KeyData {
    readonly isCharacter?: boolean;
  }
  export interface ScreenBuffer {
    put(options: { x: number; y: number; wrap?: boolean; attr?: Record<string, unknown> }, text: string): void;
    fill(options: { char?: string; attr?: Record<string, unknown> }): void;
    draw(options?: { delta?: boolean }): void;
  }
  export interface Terminal {
    fullscreen(enable: boolean): void;
    hideCursor(hide?: boolean): void;
    grabInput(options: boolean | { mouse?: string | false }): void;
    clear(): void;
    styleReset(): void;
    on(event: "key", listener: (name: string, matches: string[], data: KeyData) => void): void;
    on(event: "resize", listener: (width: number, height: number) => void): void;
    removeListener(event: "key", listener: (name: string, matches: string[], data: KeyData) => void): void;
    removeListener(event: "resize", listener: (width: number, height: number) => void): void;
    readonly width: number;
    readonly height: number;
  }
  const termkit: {
    readonly terminal: Terminal;
    readonly ScreenBuffer: { create(options: { dst: Terminal; width: number; height: number; noFill?: boolean }): ScreenBuffer };
  };
  export default termkit;
}

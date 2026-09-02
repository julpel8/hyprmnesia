declare module 'screenshot-desktop' {
  interface ScreenshotOptions {
    format?: 'png' | 'jpg' | 'jpeg' | 'bmp'
    filename?: string
    screen?: string
  }
  function screenshot(opts?: ScreenshotOptions): Promise<Buffer>
  namespace screenshot {
    function listDisplays(): Promise<
      Array<{ id: string; name: string; width: number; height: number }>
    >
  }
  export = screenshot
}

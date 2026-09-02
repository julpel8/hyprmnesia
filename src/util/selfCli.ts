export function selfCliArgs(command: string, extra: string[] = []): string[] {
  const script = process.argv[1]
  if (script && /\.(?:cjs|mjs|js|jsx|ts|tsx)$/i.test(script)) {
    return [script, command, ...extra]
  }
  return [command, ...extra]
}

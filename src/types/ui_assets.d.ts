// The frontend build artifacts (src/ui/frontend_dist/*) are gitignored and only
// exist after `bun run build:ui`. src/ui/assets.ts imports them as text with
// `import … with { type: 'text' }`; these ambient declarations tell tsc the
// imports resolve to strings even when the files are absent. Scoped to the
// frontend_dist path so no other import is affected.

declare module '*/frontend_dist/index.html' {
  const content: string
  export default content
}

declare module '*/frontend_dist/main.js' {
  const content: string
  export default content
}

declare module '*/frontend_dist/styles.css' {
  const content: string
  export default content
}

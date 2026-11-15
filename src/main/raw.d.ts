// Vite's `?raw` suffix imports a file's text. Declared here so the main-process
// and test type-checks know about it (the window gets it from vite/client, so
// this file must stay out of the window's type-check).
declare module '*?raw' {
  const content: string
  export default content
}

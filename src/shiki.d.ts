declare module 'modern-monaco/shiki' {
  export function render(code: string, options: { lang: string; theme: string }): Promise<string>
}

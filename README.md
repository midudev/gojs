# XJS ⚡

Una alternativa moderna a RunJS - un playground interactivo de JavaScript/TypeScript.

## 🚀 Características

- ✨ **Editor Monaco moderno** - Powered by `modern-monaco` con syntax highlighting
- 🎯 **Ejecución en tiempo real** - Ejecuta JavaScript/TypeScript automáticamente mientras escribes
- ⚡ **Auto-ejecución inteligente** - Debounce de 800ms para no saturar, se puede activar/desactivar
- 📝 **Validación TypeScript** - JavaScript con validación de tipos (checkJs activado)
- 🎨 **Interfaz moderna** - UI limpia y responsive con tema oscuro
- ⌨️ **Atajos de teclado** - `Cmd+Enter` / `Ctrl+Enter` para ejecutar, `Cmd+Shift+F` para formatear
- 📊 **Consola avanzada** - Soporte completo para log, info, warn, error, console.time/timeEnd, console.table y console.count
- 🔍 **Navegación inteligente** - Hover sobre logs para destacar líneas, click para ir al código
- 📍 **Números de línea** - Cada log muestra la línea exacta que lo generó
- ⏱️ **Medición de tiempo** - console.time/timeEnd con visualización especial
- 🔄 **Panel redimensionable** - Ajusta el tamaño del editor y consola
- 🔧 **Formateo automático** - Formateo al pegar y al escribir

## 🛠️ Tecnologías

- [Vite](https://vitejs.dev/) - Build tool ultrarrápido
- [modern-monaco](https://github.com/esm-dev/modern-monaco) - Editor Monaco moderno
- TypeScript - Tipado estático
- CSS moderno - Variables CSS y diseño flexible

## 📦 Instalación

```bash
# Instalar dependencias
pnpm install

# Ejecutar en desarrollo
pnpm dev

# Construir para producción
pnpm build

# Preview del build
pnpm preview
```

## 🎮 Uso

1. Escribe tu código JavaScript o TypeScript en el editor
2. El código se ejecuta automáticamente mientras escribes (debounce de 800ms)
3. También puedes presionar `Cmd+Enter` (Mac) / `Ctrl+Enter` (Windows) para ejecutar manualmente
4. Ve los resultados en tiempo real en la consola
5. Desactiva "Auto-ejecutar" si prefieres ejecución manual
6. **Hover sobre un log** para destacar la línea en el editor
7. **Click sobre un log** para ir directamente a esa línea y hacer focus
8. Usa `console.time()` y `console.timeEnd()` para medir tiempos de ejecución
9. Usa `console.table()` para visualizar arrays y objetos en formato tabla elegante
10. Usa `console.count()` para contar cuántas veces se ejecuta una línea con un label específico

## 📄 Licencia

MIT


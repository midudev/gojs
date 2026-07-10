# GoJS ⚡

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
- 🟢 **Runtime Node.js nativo (desktop)** - Ejecuta tu código contra un **Node.js 26 real** embebido en la app, con `npm install` nativo y acceso a la stdlib completa y módulos nativos

## 🖥️ App de escritorio y runtime nativo de Node.js

En la versión de escritorio (Tauri) GoJS puede ejecutar tu código de dos formas, conmutables desde el botón de runtime del header o en **Settings → Runtime**:

- **Browser sandbox** (por defecto): Web Worker aislado, funciona en cualquier lugar.
- **Node.js (native)**: lanza un proceso **Node.js 26** embebido. El código se ejecuta como en un proyecto Node real, por lo que puedes `import` paquetes de npm, usar el sistema de ficheros, etc.

Las dependencias se gestionan desde **Settings → Runtime → Dependencies**: instalar, actualizar y eliminar paquetes con `npm` nativo. Viven en un _workspace_ por usuario (`<app_data>/workspace`), así que tu código las importa como en cualquier proyecto Node.

### Compilar el escritorio

El runtime de Node se descarga y empaqueta como recurso de Tauri:

```bash
# Descarga Node 26 para tu plataforma dentro de src-tauri/runtime (una vez)
pnpm node:fetch

# Desarrollo (si no hay Node embebido, usa el `node` del PATH como fallback)
pnpm desktop:dev

# Build de producción (ejecuta node:fetch automáticamente)
pnpm desktop:build
```

> El binario de Node (~60-90 MB) está ignorado por git; `pnpm node:fetch` lo regenera. Puedes fijar una versión con `NODE_VERSION=vXX.Y.Z pnpm node:fetch`.

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

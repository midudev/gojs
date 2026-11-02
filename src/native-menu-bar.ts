// Bridge to the native menu bar visibility exposed by the Tauri backend
// (`src-tauri/src/menu_bar.rs`). Only Windows and Linux draw the menu bar inside
// the window, so the backend reports `supported: false` on macOS. The backend
// persists the choice and restores it before the first frame on launch.

import { invoke } from '@tauri-apps/api/core'

export interface MenuBarInfo {
  supported: boolean
  visible: boolean
}

export function getMenuBarInfo(): Promise<MenuBarInfo> {
  return invoke<MenuBarInfo>('menu_bar_info')
}

export function setMenuBarVisible(visible: boolean): Promise<MenuBarInfo> {
  return invoke<MenuBarInfo>('menu_bar_set_visible', { visible })
}

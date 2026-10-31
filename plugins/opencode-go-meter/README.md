# pi-opencode-go-meter

Extensión de Pi que presenta el uso de OpenCode Go como un indicador en el footer. Muestra **una ventana a la vez** y rota entre 5 horas, semanal y mensual cada 4 segundos por defecto. Si `pi-status-line` también está activo, el indicador se alinea a la derecha de la misma fila que la ruta y el estado Git; sin ese plugin aparece como estado de extensión en el footer estándar.

La barra representa el **porcentaje usado**. Los datos se actualizan cada 60 segundos por defecto. Configura `OPENCODE_GO_ROTATE_SECONDS` para cambiar la rotación (2–60 s) y `OPENCODE_GO_REFRESH_SECONDS` para cambiar la consulta de datos (15–3600 s).

## Requisitos

- Pi con soporte para extensiones;
- credencial del proveedor `opencode-go` configurada en Pi.

La extensión obtiene la API key desde `ctx.modelRegistry` y consulta `https://opencode.ai/zen/go/v1/usage`. No lee ni modifica `auth.json` directamente y no almacena la clave en este paquete.

## Instalar desde este repo

Desde la raíz de PiPLuggs:

```bash
pi install ./plugins/opencode-go-meter
```

Después reinicia Pi o recarga las extensiones. Para ocultar la barra compacta de otra extensión que ya esté instalada, ejecuta `/go-status` en esa extensión.

## Uso

- El indicador aparece al iniciar una sesión TUI si hay credenciales `opencode-go` configuradas.
- `/go-meter` fuerza una consulta y muestra los porcentajes y tiempos de reinicio.
- La frecuencia predeterminada se cambia al iniciar Pi, por ejemplo:

  ```bash
  OPENCODE_GO_REFRESH_SECONDS=30 pi
  ```

## Instalación desde npm después de publicar

Cuando el paquete esté publicado con un nombre npm disponible:

```bash
pi install npm:pi-opencode-go-meter
```

El endpoint de uso lo emplean otras integraciones, pero no está documentado en la guía pública de Go; OpenCode podría cambiarlo. La extensión requiere una API key y debe revisarse antes de instalarse o publicarse.

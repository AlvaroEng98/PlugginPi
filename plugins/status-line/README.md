# pi-status-line

Extensión para Pi que reemplaza el footer inferior por una barra compacta inspirada en [Creating The Perfect Claude Code Status Line](https://www.aihero.dev/creating-the-perfect-claude-code-status-line).

Muestra la ruta del proyecto, la rama Git, archivos preparados/modificados/nuevos y el porcentaje de contexto de la sesión. Ejemplo:

```text
~/Proyectos/PiPLuggs | main | S: 1 | U: 2 | A: 1 | 17.3%
modelo: opencode-go/glm-5.3 | esfuerzo: high
```

- `S`: archivos con cambios preparados (`git diff --cached`).
- `U`: archivos con cambios sin preparar (`git diff`).
- `A`: archivos sin seguimiento.
- El porcentaje se colorea según el uso del contexto; `?%` aparece cuando Pi aún no puede estimarlo.
- El estado Git se consulta en segundo plano cada 5 segundos, sin bloquear el renderizado de la terminal.
- Si `opencode-go-meter` está instalado, su cuota ocupa el extremo derecho de la primera línea, alineada con la ruta y el estado Git.
- La segunda línea muestra el proveedor/modelo activo y el nivel de esfuerzo (`thinkingLevel`); si no hay modelo seleccionado, indica `sin modelo`.
- Los textos añadidos por otras extensiones con `ctx.ui.setStatus()` se mantienen debajo de esos datos.
- Al sustituir el footer estándar, deja de mostrar allí los totales de tokens/coste de Pi.

## Instalar desde este repo

```bash
pi install ./plugins/status-line
```

Reinicia Pi o recarga las extensiones. Para volver al footer estándar, desinstala o desactiva esta extensión y reinicia/recarga Pi.

Por defecto, las rutas dentro de `$HOME` se muestran relativas a tu directorio personal (`~/...`). Para usar otra raíz:

```bash
PI_STATUS_LINE_ROOT="$HOME/repos" pi
```

Las rutas bajo esa raíz se muestran relativas a ella. Las rutas fuera de la raíz configurada se muestran absolutas.

La extensión necesita que `git` esté instalado. Fuera de un repositorio muestra la ruta y el porcentaje de contexto, sin los contadores Git.

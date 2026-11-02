# Análisis de subagentes: PiPLuggs y Gentle Shell

## Referencia revisada

Repositorio: [Gentleman-Programming/gentle-shell](https://github.com/Gentleman-Programming/gentle-shell)
Revisión consultada: `0088518dbc558565c5d2f5b1607d926017b9201c` (`2026-11-01`).

## Cómo los trata Gentle Shell

### Procesos e interacción con el agente principal

- Cada subagente es un proceso Pi independiente en modo RPC (`pi --mode rpc`). El principal conserva su papel de orquestador; no se sustituye su conversación por la del hijo.
- El host consume los eventos RPC y los convierte en cambios de estado y elementos de hilo asociados a la tarea: texto, pensamiento, herramientas y notas.
- Hay dos modos: `task`, que espera el resultado, y `background`, que devuelve un ID enseguida. El trabajo en segundo plano sigue activo y su resultado se entrega después, sin polling.
- El proceso del hijo tiene cancelación, watchdog de inactividad y limpieza de grupo de procesos.

### Interfaz

- Una tarjeta compacta sobre el editor resume las tareas, su actividad y metadatos.
- `/gentle:agents` o `alt+a` abre una vista de pantalla completa con las tareas en un panel y el hilo del subagente seleccionado en otro. Seleccionar una tarea cambia el hilo mostrado, no la conversación principal.
- Desde la vista se puede detener una tarea activa. Se conserva historial reciente y los hilos se pueden consultar.

### Mensajes

- `subagent_send_message` dirige un mensaje a un hijo activo mediante `runner.steer`; Pi lo entrega antes de su siguiente llamada al modelo.
- El panel de Gentle Shell no ofrece un compositor propio para redactar mensajes. El envío se realiza mediante la herramienta del orquestador.
- La comunicación del hijo hacia el padre es distinta: usa IPC para notificaciones y consultas. En modo `task`, una consulta puede abrir un diálogo al usuario y contestarse con `subagent_reply`; las consultas de un hijo `background` se cancelan para no bloquearlo.

## Comparación con `subagent-dashboard`

El plugin actual tiene:

- Procesos RPC independientes para subagentes.
- Un panel compacto que solo aparece mientras hay agentes activos.
- Una vista dedicada (`/subagents` o `alt+a`) con tareas y actividad estructurada por agente; conserva los tres resultados recientes durante la sesión.
- Selección por clic en el panel y navegación por teclado en la vista dedicada.
- Envío de instrucciones (`steer`) y cancelación individual desde el panel, la vista y los comandos.

Diferencias principales respecto a Gentle Shell:

- La vista del plugin reconstruye un hilo de texto, llamadas a herramientas y sus resultados; no persiste ese hilo entre sesiones ni reproduce todo el transcript semántico de Pi.
- El plugin admite `mode: "background"` solo para una llamada individual; arreglos paralelos y cadenas siguen siendo síncronos. Los resultados se entregan al padre automáticamente mediante `pi.sendMessage`, sin polling.
- No implementa el canal IPC hijo→padre para consultas/respuestas de usuario que tiene Gentle Shell.
- El padre permanece intacto mientras el subagente trabaja. La vista dedicada enfoca el hilo del hijo, pero no lo convierte en la conversación principal.

## Conclusión

La coexistencia del agente principal y los subagentes es el modelo esperado. El plugin conserva actividad durante la sesión, ofrece una vista dedicada y permite delegar tareas individuales en segundo plano con ID y entrega automática del resultado. El paso futuro más cercano a Gentle Shell sería persistir/restaurar el hilo semántico o añadir comunicación IPC hijo→padre, si ambos flujos hacen falta.

## Fuentes

- `docs/gentle-shell.md`, sección “Gentle Agents”.
- `extensions/gentle-agents.ts`: tarjeta, herramienta de ejecución, envío y cancelación.
- `lib/agents-runner.ts`: proceso RPC, eventos, `steer` y ciclo de vida.
- `lib/agents-view.ts`: selección, hilo, controles y vista de tareas.
- `lib/agents-protocol.ts`: estados, eventos e hilo por tarea.

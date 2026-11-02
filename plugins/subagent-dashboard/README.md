# pi-subagent-dashboard

Extensión para delegar trabajo a subagentes aislados y observarlos mientras están activos.

El panel compacto aparece solo mientras hay subagentes activos. Para verlos en una pantalla dedicada, usa `/subagents` o `alt+a`: muestra la lista de tareas y el hilo de actividad del subagente seleccionado, y sigue actualizándose mientras trabaja. Desde esa vista puedes cancelar con `c` o redactar una instrucción con `m`. Al terminar el último subagente, el panel compacto desaparece; la vista conserva los tres resultados recientes durante la sesión.

```text
SUBAGENTES 2 activos · clic para seleccionar
▶ scout · read src/auth.ts · ⏳
  reviewer · Generando respuesta · ⏳
Tarea: localiza el flujo de login y sus pruebas
Actividad: read src/auth.ts · anthropic/claude-... · esfuerzo high
Salida en vivo:
  Revisando el middleware de autenticación…
  › read src/auth.ts
  › grep /login/ src
  ✉ Enviar mensaje (clic o /subagent-message)
  ✕ Cancelar subagente (clic o /subagent-cancel)
```

Los subagentes se ejecutan en procesos RPC independientes de `pi`. El panel muestra actividad y texto mientras llegan eventos; el contexto del hijo avanza al completarse cada respuesta del modelo. Los mensajes enviados durante una ejecución se entregan como instrucciones de dirección (steering). Cuando Pi no tiene metadatos del contexto del modelo, se muestran los tokens conocidos sin porcentaje.

Acciones disponibles:

- Usa `/subagents` o `alt+a` para abrir la vista de tareas e hilo; `↑`/`↓` seleccionan agentes o desplazan el hilo, `Tab` cambia de panel, `c` cancela y `m` redacta un mensaje. `Esc` cierra la vista.
- Haz clic en la fila del panel compacto para cambiar la salida en vivo.
- Haz clic en «Enviar mensaje» o ejecuta `/subagent-message`; el comando también acepta texto, por ejemplo `/subagent-message prioriza los tests`.
- Haz clic en «Cancelar subagente» o ejecuta `/subagent-cancel`.

## Instalar desde este repo

```bash
pi install ./plugins/subagent-dashboard
```

Reinicia Pi o recarga las extensiones. Usa la herramienta `subagent` para delegar:

```text
Lanza a scout en background para localizar el flujo de autenticación y entrégame el resultado al terminar
```

El resultado inicial incluye el ID de tarea; el plugin entrega automáticamente el resultado al contexto del padre al finalizar.

```text
Usa scout para encontrar el flujo de autenticación
```

```text
Lanza en paralelo a scout y reviewer: que investiguen el flujo de autenticación desde ángulos distintos
```

También admite cadenas secuenciales con `{previous}`. En una llamada individual, `mode: "background"` devuelve un ID inmediatamente y entrega el resultado al padre cuando termina —como steering si está ocupado o iniciando un turno si está inactivo—; no hace falta consultar ni dormir esperando. El modo predeterminado `task` sigue esperando el resultado. Background requiere una sesión TUI/RPC persistente, no está disponible en print/JSON y admite hasta cuatro tareas concurrentes; cambiar o cerrar la sesión cancela las que sigan activas. Los arreglos paralelos y las cadenas siguen siendo síncronos. Los agentes `scout`, `planner`, `reviewer` y `worker` vienen incluidos; al no fijar un modelo, heredan el modelo y esfuerzo de la sesión principal.

## Agentes personalizados y seguridad

Los agentes del usuario se leen desde `~/.pi/agent/agents/*.md` y reemplazan los perfiles incluidos si comparten nombre. Los agentes del proyecto están en `.pi/agents/*.md`; para usarlos, pide `agentScope: "project"` o `"both"`. En proyectos no confiables Pi pide confirmación antes de ejecutarlos.

Cada subagente se ejecuta como un proceso `pi` con las herramientas y permisos definidos por su perfil. Revisa los perfiles y trata con cuidado los repositorios y extensiones de terceros.

## Alcance del panel

El plugin observa únicamente subagentes lanzados con esta herramienta en la sesión actual; no detecta procesos externos ni agentes lanzados por otras extensiones. El panel compacto muestra solo procesos activos; la vista dedicada conserva hasta tres resultados recientes en memoria hasta cerrar o cambiar de sesión. Los clics del panel dependen del modo de terminal que admite ratón; `/subagents`, `/subagent-message` y `/subagent-cancel` ofrecen el flujo equivalente con teclado.

# PiPLuggs

Monorepo para las extensiones de Pi que usamos y publicamos. Cada plugin vive en su propia carpeta y tiene su propio `package.json`, manifiesto Pi y README; así se pueden desarrollar e instalar por separado.

## Plugins

| Plugin | Descripción | Instalación local |
|---|---|---|
| [`opencode-go-meter`](./plugins/opencode-go-meter/) | Barra fina de cuota de OpenCode Go a la derecha; rota entre 5 h, semanal y mensual | `pi install ./plugins/opencode-go-meter` |

## Estructura para añadir otro plugin

```text
plugins/
└── nombre-del-plugin/
    ├── package.json       # nombre npm y manifiesto "pi"
    ├── README.md          # instalación y uso
    └── extensions/        # extensiones TypeScript/JavaScript
        └── index.ts
```

El `package.json` de la raíz solo organiza el workspace; no es un plugin instalable. Las dependencias del host Pi se declaran como `peerDependencies` en el paquete individual y no se empaquetan.

## Probar el plugin de OpenCode Go

Desde la raíz del repo:

```bash
pi install ./plugins/opencode-go-meter
```

Reinicia Pi o recarga las extensiones. Ejecuta `/go-meter` para actualizar y ver los tiempos de reinicio. Desactiva con `/go-status` la línea compacta de `@oscarfalero/pi-opencode-go` si aún aparece.

## Publicar un plugin para que cualquiera lo instale

El paquete debe tener un nombre npm disponible, un manifiesto `pi`, documentación y una licencia elegida por quienes mantienen el proyecto. Para `opencode-go-meter`:

1. Revisa `plugins/opencode-go-meter/package.json` y confirma un nombre npm único.
2. Verifica el contenido que se publicará:
   ```bash
   cd plugins/opencode-go-meter
   npm pack --dry-run
   ```
3. Publica el paquete desde su carpeta con una cuenta npm:
   ```bash
   npm login
   npm publish
   ```
4. Tras publicarlo, cualquiera podrá instalarlo en Pi con:
   ```bash
   pi install npm:pi-opencode-go-meter
   ```

Para publicar bajo un scope, cambia el nombre a `@scope/pi-opencode-go-meter` y publica con `npm publish --access public`; el comando de instalación sería `pi install npm:@scope/pi-opencode-go-meter`.

Antes de publicar, reemplaza cualquier nombre provisional por el nombre npm que se haya reservado, añade el repositorio público y decide/licencia el proyecto. Pi carga código ejecutable: publica solo después de revisar el contenido del paquete.

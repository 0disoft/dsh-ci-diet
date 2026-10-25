# CI Diet

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-Hans.md) · [हिन्दी](README.hi.md) · [Español](README.es.md) · [Français](README.fr.md)

**Estado:** alfa; `dsh-ci-diet@0.5.1` está en npm. El código fuente actual añade la pantalla de revisión **Ajustes → CI Diet Reports** a los contratos, los motores de análisis y parches, la CLI, las herramientas DSH, la página de ajustes y el informe HTML autocontenido. La pantalla de revisión ya había superado una prueba E2E en un navegador real en un commit anterior. La migración única de valores predeterminados se verificó por separado en el runtime de DSH `0.2.1-rc.2` con configEditor, SettingsForms y Loader; no fue una nueva comprobación del renderizado del navegador. El plugin de DSH ahora arranca con preflight, acceso de red para el historial y aplicación local activados.

**Valores predeterminados y migración de DSH.** Los perfiles nuevos habilitan `preflightEnabled`, `networkEnabled`, `localApplyEnabled` y CD001, CD002, CD004, CD006 y CD008. La migración de perfiles bloqueados registra `defaultsRevision: 2`. Los perfiles que ya se migraron a la revisión 1 conservan las selecciones posteriores de interruptores y reglas. Se conservan las rutas de estado, la retención, las cuotas y los datos numéricos existentes de la cuenta. CD003 y CD005 permanecen desactivados salvo que se habiliten. Las estimaciones monetarias usan automáticamente ambos datos de la cuenta; en blanco significa desconocido y un `0` explícito es válido. La facturación que se habilitó anteriormente conserva sus valores predeterminados en cero cuando se omite un valor.

CI Diet detecta trabajo de GitHub Actions que probablemente se desperdicia, conserva la evidencia de cada hallazgo y muestra una vista previa de pequeños cambios en los workflows para que una persona los revise.

**La instalación por sí sola no ahorra minutos de runner.** Los comandos de despliegue DSH admitidos comprueban automáticamente si hay candidatos de ahorro antes de ejecutarse; los cambios de workflow solo se aplican tras revisión y aprobación. El plugin de DSH no tiene herramientas de aprobación, aplicación ni reversión, y preflight nunca modifica archivos. Sus páginas de ajustes guardan la configuración y muestran los informes y planes de sesión del host; no optimizan un workflow. Las escrituras locales aprobadas están activadas por defecto, pero aplicar aún requiere una aprobación de digest separada. No hay garantía de que un hallazgo reduzca el coste.

`preflightEnabled` está activado por defecto. Antes de un literal `git push`, `npm|pnpm|bun publish`, `wrangler deploy` o `npm|pnpm|bun run deploy` en una herramienta bash DSH sin estado admitida (con argumento `workdir`), CI Diet hace una comprobación sin conexión. Señala para revisión los candidatos npm CD006, la falta de concurrency en un workflow solo de PR y una instalación Bun frozen sin caché de descargas explícita. Si hay candidatos, el primer comando no se ejecuta; tras revisar los elementos, el modelo puede reintentar el mismo comando. El propio preflight no hace peticiones de red ni cambios automáticos de archivos, y aplicar un plan sigue necesitando aprobación humana. Las shells persistentes y los wrappers de shell complejos no se identifican de forma fiable, así que preflight los omite. El ahorro sigue sin medirse, así que no se afirma ningún ahorro.

## Qué hace

El scan estático lee el YAML de los workflows en un checkout de destino. La sincronización opcional del historial usa llamadas `gh api` de solo lectura para recopilar ejecuciones recientes. Los hallazgos incluyen un nivel de evidencia (`observed`, `inferred` o `static`) y una cobertura de recopilación por eje.

| Regla | Qué detecta | Plan posible |
| --- | --- | --- |
| CD001 | Ejecuciones de PR que quedan obsoletas por un commit más reciente | modificación de `concurrency` |
| CD002 | Disparadores solapados | solo explicación |
| CD003 | Comprobaciones pesadas para cambios que solo afectan a la documentación | solo explicación; desactivada por defecto |
| CD004 | Matrices de gran tamaño | solo explicación |
| CD005 | Jobs sin `timeout-minutes` | modificación del timeout; desactivada por defecto |
| CD006 | npm / pnpm / Bun | [CD006](docs/spec/rules.md) |
| CD008 | Retención prolongada de artefactos | modificación de la retención |

CD001 ayuda a tratar las ejecuciones de PR solapadas que han quedado obsoletas. CD005 limita las ejecuciones anómalas; no reduce el tiempo de ejecución normal de un job. CD008 cambia la retención del almacenamiento de artefactos, no los minutos de runner. CD003 y CD005 permanecen desactivadas hasta que superen sus controles de calidad.

CD006 también admite configuraciones verificadas de npm/pnpm y trabajos de Bun que usan `oven-sh/setup-bun@v2` seguido de `bun install --frozen-lockfile` con un `bun.lock` de texto versionado. Bun añade un paso de caché de descargas; la instalación y las pruebas se siguen ejecutando. La sobrecarga de restaurar y guardar la caché puede superar el beneficio. Consulta las [condiciones actuales de caché](docs/spec/rules.md#bun-dependency-cache-variant) y [un ejemplo medido](docs/measurements/2026-10-25-cache-review.md). El ejemplo de npm de abajo muestra una de las formas admitidas.

## Instalación y actualización

La CLI requiere Node `^22.19.0 || >=24.0.0`. El plugin admite DSH `>=0.2.1-rc.2 <0.3.0-0` y `>=0.2.2-rc.1 <0.3.0-0`. La versión `0.3.1` se probó con DSH `0.2.1-rc.2`; DSH `0.3.0` no es compatible.

```
npm install --global dsh-ci-diet@0.5.1
ci-diet --version
```

Si no instalas el paquete de forma global, sustituye el nombre de comando `ci-diet` por `npx dsh-ci-diet@0.5.1`, por ejemplo `npx dsh-ci-diet@0.5.1 report --cwd .`.

```
dsh plugin --profile web add dsh-ci-diet@0.5.1
dsh --profile web
```

La instalación registra las herramientas del plugin, la página de ajustes y la pantalla de revisión **Ajustes → CI Diet Reports**. Preflight, acceso a la red y aplicación local están activados por defecto en el plugin. La instalación y el arranque no llaman a `gh`, no recopilan historial, no ejecutan un scan y no modifican un workflow.

```
npm install --global dsh-ci-diet@latest
dsh plugin --profile web add dsh-ci-diet@latest
```

Reinicia DSH después de actualizar el plugin. Usa `dsh plugin --profile web list`, `ci-diet --version` o `npx dsh-ci-diet@latest --version` para comprobar las versiones instaladas.

## Primer scan e informe del historial

Ejecuta estos comandos desde el repositorio que quieres inspeccionar. `--cwd .` significa ese repositorio; `--cwd` acepta otra ruta, y las rutas relativas se resuelven desde el directorio de trabajo efectivo. El primer comando funciona sin conexión. La recopilación del historial es una activación de red aparte y explícita.

```
ci-diet scan --cwd .
gh auth status
ci-diet sync --cwd . --network
ci-diet report --cwd .
ci-diet report --cwd . --format html --out report.html
```

`scan` imprime un informe estático sin acceso a la red; `--json` o `--out FILE` escribe esa salida, pero el scan de la CLI no guarda un informe en el almacén de estado. `report` necesita un informe guardado por `sync` de la CLI, por `ci_diet_scan` del plugin o por `ci_diet_sync` del plugin. En esta secuencia que usa solo la CLI, sync guarda el informe; después, la opción HTML escribe un único archivo autocontenido. La sincronización del historial necesita `gh` instalado, autenticado y capaz de leer las ejecuciones y jobs de Actions del repositorio. `sync --network` es la activación explícita de la CLI. Nunca necesita permiso de escritura en GitHub. Un historial parcial aún genera y guarda un informe, y marca la cobertura como incompleta. El `ci_diet_scan` sin conexión del plugin sí guarda su informe, así que `ci_diet_report` puede ejecutarse justo después.

En el plugin de DSH, el acceso a la red está activado por defecto, así que `ci_diet_sync` puede ejecutarse en cuanto `gh` esté instalado y autenticado. El interruptor solo permite que esa herramienta llame a `gh`; la instalación, el arranque y el guardado de ajustes no recopilan historial por sí solos. Para impedir el uso de red del plugin, desactiva **Permitir acceso a la red** en **Ajustes → CI Diet** y elige **Guardar cambios**. El ajuste de la página se aplica a las herramientas del plugin; no activa el flag `--network` de la CLI. El scan estático y el informe funcionan sin red. La página de ajustes no ejecuta una optimización por sí sola.

Una solicitud útil en el chat deja explícitos la secuencia y el límite de revisión. Sustituye la ruta absoluta del ejemplo por la de tu repositorio:

> Ejecuta `ci_diet_scan` con cwd `C:\work\my-repo`; después, `ci_diet_sync` para ese mismo cwd y `ci_diet_report`. Si `gh` no está autenticado o desactivo el acceso a la red, detente tras el scan. Si vas a previsualizar un parche con `ci_diet_plan`, muestra solo las modificaciones. No apruebes, apliques ni reviertas nada, y no hagas commits, push ni despliegues.

La vista previa del plugin no guarda un plan. Su `nextCommand` vuelve a crear el plan mediante la CLI para que el plan sea duradero y pueda entrar en el flujo de aprobación humana.

## Plan sin conexión de caché npm (CD006)

CD006 no necesita historial de ejecuciones. Detecta un job en la raíz del repositorio donde `actions/checkout` no tiene opciones `with` del usuario, le sigue exactamente un paso `actions/setup-node@v3` o `@v4` sin caché y el `run` del paso siguiente es exactamente `npm ci`. `package.json` y `package-lock.json` de la raíz deben estar versionados como archivos JSON normales. El plan solo añade `cache: npm` y `cache-dependency-path: package-lock.json` a setup-node; no cambia Node, las versiones de las acciones, `npm ci`, las pruebas ni el almacenamiento local.

```
ci-diet plan --cwd . --rule CD006 --workflow .github/workflows/ci.yml --job test --step 1
ci-diet plans --cwd . --plan PLAN_ID
```

`--step` es el índice basado en cero del paso setup-node; el ejemplo supone que checkout es 0 y setup-node es 1. La CLI `plan` ejecuta este escaneo estático en memoria y guarda el plan sin un `sync` previo; deja intacto el informe guardado más reciente. La herramienta de plugin `ci_diet_plan` sigue necesitando un informe guardado, así que ejecuta `ci_diet_scan` primero. La aprobación y la aplicación usan los comandos existentes de abajo. El plan y su attestation se guardan durante la planificación; ningún archivo de workflow cambia hasta que una persona aprueba el plan y ejecuta apply.

## Referencia de comandos de la CLI

```
ci-diet scan --cwd .
ci-diet sync --cwd . --network
ci-diet sync --cwd . --network --repo OWNER/REPO --days 7
ci-diet report --cwd .
ci-diet report --cwd . --format json
ci-diet report --cwd . --format html --out report.html
ci-diet diagnose --cwd .
ci-diet prune
ci-diet changes --cwd .
ci-diet plans --cwd . --plan PLAN_ID
ci-diet report --cwd . --lang ko
```

`scan` comprueba los archivos de workflow. `sync` lee el historial solo después de `--network`; `--repo` selecciona `OWNER/REPO` de forma explícita y `--days` ajusta el periodo de retrospectiva dentro de sus límites configurados. `report` genera texto, JSON o HTML y escribe `--out` en una ruta relativa a `--cwd`. `diagnose` explica la correspondencia de nombres de job y la cobertura a partir del historial guardado; añade `--require-complete` para salir con el código `3` si los datos están incompletos. `prune` elimina informes, planes y entradas de caché caducados según la configuración del almacén de estado. `changes` enumera los cambios aplicados; `plans` vuelve a abrir un plan guardado. `--config FILE` combina una configuración JSON parcial en cualquier comando.

## Revisar, aprobar, aplicar y revertir

Un `plan` correcto de la CLI imprime el diff propuesto, un ID de plan real como `p_...` y una confirmación formada por los últimos 12 caracteres del digest del plan. La creación del plan rechaza evidencia obsoleta y otras escrituras inseguras; un workflow inexistente puede ser un error de uso con salida `1`. Si se consulta un plan guardado después de que desaparezcan su workspace o su workflow, `plans --plan` oculta el diff, conserva el JSON del plan, pide volver a planificar y sale con `3`. Lo mismo ocurre cuando los bytes del workflow ya no coinciden con el hash de origen guardado. Revisa el diff y el plan otra vez antes de aprobar.

```
ci-diet plan --cwd . --rule CD001 --workflow .github/workflows/ci.yml --claims ci-only,replace-safe
ci-diet plans --cwd . --plan PLAN_ID
ci-diet approve --cwd . --plan PLAN_ID --confirm CONFIRMATION
ci-diet apply --cwd . --plan PLAN_ID
ci-diet revert --cwd . --change CHANGE_ID
```

Sustituye `PLAN_ID` por el ID que imprime el plan, `CONFIRMATION` por sus últimos 12 caracteres del digest y `CHANGE_ID` por el ID que imprime apply. Cada valor es un argumento literal; no escribas los corchetes angulares. `approve` crea una aprobación de un solo uso, `apply` reescribe únicamente el rango de bytes planificado en un archivo de workflow y `revert` restaura la copia de seguridad de ese cambio. Revisa el diff resultante y ejecuta las comprobaciones del repositorio según sea necesario. CI Diet no hace commits, push ni despliegues, no ejecuta workflows, no cambia la protección de ramas ni elimina artefactos.

Para una CI apta que solo se ejecuta en PRs, el ejemplo de CD001 usa `ci-only` y `replace-safe` como declaraciones humanas. Indican que la persona operadora ha revisado la semántica de cancelación; no son interruptores de omisión. CD005 necesita un `--job` y un `--minutes` medidos, y CD008 necesita `--job`, un índice numérico basado en cero del array `--step` para el paso objetivo y declaraciones sobre artefactos. CD006 necesita `--job` y el índice basado en cero `--step` del paso setup-node/setup-bun; no usa declaraciones. En ambas reglas de paso, el número es un índice del array y no un token con el nombre del paso.

## Estado y limitaciones

La CLI y el plugin comparten el directorio de estado predeterminado: `%LOCALAPPDATA%\CI-Diet\profiles\default` en Windows y, en otros sistemas, `~/.local/state/ci-diet/profiles/default`. Una anulación de `stateDir` en el plugin es un almacén aparte; pasa la misma ruta absoluta a la CLI con `--state-dir` en `plan`, `approve`, `apply` y `revert`. Las rutas relativas de `--state-dir` de la CLI se resuelven contra el `--cwd` efectivo. El estado existente nunca se migra automáticamente entre directorios.

El cliente web tiene Ajustes y la pantalla de revisión **CI Diet Reports**. Los controles de informe, aprobación, aplicación y reversión ya habían superado una prueba E2E en un navegador real en un commit anterior. La migración de valores predeterminados se verificó por separado en el runtime de DSH `0.2.1-rc.2` con configEditor, SettingsForms, Loader y un perfil temporal: los valores `false` heredados se guardaron como `true`, y un `false` guardado después siguió desactivado tras reiniciar. Esta prueba de runtime no verificó un nuevo renderizado del navegador. La aprobación y la aplicación llegan al host desde esa pantalla, y `localApplyEnabled` está activado por defecto. Ninguna herramienta del plugin realiza aprobaciones ni aplicaciones. Un plan edita un único workflow existente mediante rangos de bytes y rechaza estructuras no admitidas. Los hallazgos pueden ser incorrectos o incompletos cuando el historial o la atribución de workflows es parcial, y otro sistema puede tener datos de facturación más precisos. Usa el informe como evidencia para la revisión y luego verifica el efecto en GitHub.

## Coste y evidencia

| Campo | Significado |
| --- | --- |
| `observedRunnerSeconds` | Tiempo de runner registrado por las ejecuciones recopiladas |
| `modeledRoundedMinutes` | Minutos por job redondeados hacia arriba para la modelización |
| `listPriceUsd` | Coste según la instantánea de precios de catálogo incorporada |
| `actualBilledUsd` | Siempre `null` hasta que se pueda demostrar la factura real |

Los informes incorporan la instantánea de precios y un hash del contenido para que las cifras se puedan reproducir. No afirman ahorros automáticos. El informe HTML usa CSS en línea, no contiene scripts y no realiza solicitudes externas.

## Idiomas

La interfaz de ajustes de DSH, los mensajes de la CLI, los informes HTML y estos seis READMEs admiten inglés, coreano, chino simplificado, hindi, español y francés. Las especificaciones detalladas siguen en inglés. El orden de selección es `--lang`, la configuración regional de DSH, `LC_ALL`/`LC_MESSAGES`/`LANG` y, por último, inglés. Los códigos de idioma de la CLI son `en`, `ko`, `zh-Hans`, `hi`, `es` y `fr`; sustituye `ko` en el comando de ejemplo por el código que quieras. Las etiquetas regionales se resuelven por idioma. Los informes se guardan en inglés y se localizan al mostrarse. Los IDs de regla, códigos de error, valores de enum, rutas, hashes y números permanecen literales. El atributo `lang` del HTML sigue la configuración regional seleccionada. Las descripciones de las herramientas DSH se capturan al cargar el plugin, así que recarga después de cambiar la preferencia de idioma de DSH.

## Desarrollo

```
bun install
node scripts/test-core.mjs
node scripts/gen-types.mjs --check
node scripts/sync-contracts.mjs --check
bun run typecheck
bun run lint
bun run test:docs
```

Ejecuta las pruebas con Node para que los puntos de entrada publicados sigan siendo compatibles con Node. Bun se usa para gestionar dependencias.

## Publicación

Hacer push de una etiqueta que coincida con `package.json` inicia `.github/workflows/publish.yml`. En los siguientes comandos, sustituye el literal `VERSION` de ambos argumentos por una versión nueva; la versión `0.3.1` ya está publicada, así que no vuelvas a crear esa etiqueta.

```
git tag vVERSION
git push origin vVERSION
```

El workflow compara la etiqueta con `package.json`, ejecuta las comprobaciones de publicación, rechaza una versión ya existente en npm y publica con la publicación de confianza de npm mediante GitHub OIDC. El publicador de confianza debe indicar `publish.yml`.

## Estructura

```
src/core        workflow parsing, rules, savings, patch engine
src/adapters    GitHub, git, storage
src/client      Web Settings and review UI
src/dsh         host plugin and bundle code
src/cli         command-line entry
src/shared      i18n and shared helpers
contracts       JSON Schemas from the frozen design pack
examples        sample records and evaluation vectors
docs/spec       normative specification
scripts         contract and documentation checks
tests/unit      fast checks that need no network
```

## Documentación

Los documentos detallados de especificación, reglas, costes, parches, almacenamiento y decisiones están en inglés. El índice de la especificación es [docs/spec/README.md](docs/spec/README.md). También están disponibles: [rules](docs/spec/rules.md), [cost model](docs/spec/cost-model.md), [patch model](docs/spec/patch-model.md), [storage and errors](docs/spec/storage.md), [decisions](docs/spec/decisions.md), [measurement](docs/spikes/a0a-rules.md), la [plugin and CLI guide](docs/guide/plugin.md) y [contract provenance](contracts/UPSTREAM.md).

## Licencia

MIT

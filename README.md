# GDrive Vault Sync

Sincroniza un vault de Obsidian a través de **tu propio Google Drive**, en escritorio (Linux, macOS, Windows) y en iPhone. Sin servidores de terceros.

Es un fork de [RichardX366/Obsidian-Google-Drive](https://github.com/RichardX366/Obsidian-Google-Drive) (0BSD), con el login y el motor de sincronización rehechos.

## Qué cambia respecto al original

| | Original | Este fork |
|---|---|---|
| Login | Página y servidor del autor (`ogd.richardxiong.com`) ven tu refresh token | Tu propio cliente OAuth de Google, con PKCE. Nadie más en medio |
| Permiso en Drive | El que otorgue la web del autor | `drive.file`: solo ve los archivos que el propio plugin crea |
| Dónde vive el token | `data.json` del plugin, **que además se subía a Drive** | Almacén de secretos de Obsidian en cada equipo. Nunca se sube |
| Detectar cambios remotos | Búsqueda por `modifiedTime` contra el reloj local, más feed de cambios | Solo el feed de cambios de Drive, con el checkpoint que devuelve el propio feed |
| Archivos sin cambios | Se vuelven a subir o descargar | Se saltan comparando MD5 |
| Concurrencia | Lotes fijos de 10 (el más lento bloquea el lote) | Pool de 8 workers |
| Errores 429/5xx | Falla la sincronización | Reintento con backoff exponencial y `Retry-After` |
| Conflictos | Gana el local y el remoto se pierde | Se guarda el remoto como `nota (conflict AAAA-MM-DD HHMM).md` |
| Equipo nuevo | El vault debía estar vacío | Adopta una copia local existente comparando MD5 |
| Auto-push | Apagado, 60 s | Encendido, 30 s (configurable) |
| Al volver a la app | Nada | Pull automático (útil en iPhone) |

## Configuración única en Google Cloud (unos 10 minutos)

1. Entra en [console.cloud.google.com](https://console.cloud.google.com) y crea un proyecto, por ejemplo `obsidian-sync`.
2. **APIs y servicios → Biblioteca**: activa **Google Drive API**.
3. **Google Auth Platform → Branding**: pon un nombre de app y tu correo.
4. **Audience**: tipo **External**. Pulsa **Publish app** para dejarla **In production**.
   - Esto es importante. En modo *Testing* los refresh tokens caducan a los 7 días.
   - `drive.file` es un permiso no sensible, así que no hace falta pasar la verificación de Google.
5. **Data access → Add or remove scopes**: añade `https://www.googleapis.com/auth/drive.file`.
6. **Clients → Create client → Web application**. En **Authorized redirect URIs** pon la URL de tu página de callback:
   `https://andresurcisichi.github.io/obsidian-drive-sync/callback.html`
7. Copia el **Client ID** y el **Client secret**.

La página de callback es [`docs/callback.html`](docs/callback.html), servida con GitHub Pages desde la carpeta `docs/` de este repo. Es estática: lee el código de Google, lo borra de la barra de direcciones y te devuelve a Obsidian con `obsidian://gdrive-vault-sync-auth`. Si el salto no funciona, muestra el código para pegarlo a mano.

## Compilar

```bash
cp .env.example .env   # pon GDVS_CLIENT_ID, GDVS_CLIENT_SECRET y GDVS_REDIRECT_URI
npm install
npm run build          # genera main.js con esos valores integrados
npm test
```

Con `.env` cada equipo solo necesita pulsar **Sign in with Google**. Sin `.env`, introduce los tres valores en los ajustes del plugin. El client secret se guarda en el almacén de secretos de Obsidian, no en el vault.

> El client secret de una app instalada no es un secreto real; Google lo asume así. Con él solo se puede iniciar el login contra tu proyecto: no da acceso a tus archivos. Lo que protege tus datos es el refresh token, que no sale de cada equipo.

## Instalar

**Escritorio:** copia `main.js`, `manifest.json` y `styles.css` a `<vault>/.obsidian/plugins/gdrive-vault-sync/` y actívalo en **Settings → Community plugins**.

**iPhone:**
1. Instala **BRAT** desde los plugins de la comunidad.
2. **BRAT → Add beta plugin**: `AndresUrcisichi/obsidian-drive-sync`.
3. Crea el vault en **En mi iPhone**, nunca en iCloud, porque los dos sincronizadores se pelean. Usa el mismo nombre de vault que en el escritorio.
4. Abre los ajustes del plugin y pulsa **Sign in with Google**. Safari te devuelve a Obsidian.

A partir de ahí, las actualizaciones del plugin hechas en el escritorio llegan al iPhone con la sincronización de configuración.

## Primer uso

1. **Haz un backup del vault.**
2. En el equipo principal, inicia sesión. El primer pull ve el Drive vacío y marca todas tus notas para subir. Haz **Push to Google Drive**.
3. En cada equipo nuevo, tienes dos opciones:
   - Inicia sesión directamente y deja que descargue todo.
   - O, si el vault es grande, descarga la carpeta desde drive.google.com, ábrela como vault e inicia sesión. El plugin la adopta comparando MD5 y no descarga nada.

## Comandos

- **Push to Google Drive**: hace un pull y luego sube los cambios locales.
- **Pull from Google Drive**: trae los cambios remotos.
- **Reset local vault to Google Drive**: descarta los cambios locales.
- **Rebuild sync index from Google Drive**: rehace el mapa local de IDs desde Drive.

## Reglas

- No subas archivos a mano a la carpeta del vault en Drive. Con `drive.file` el plugin no los ve.
- No edites el vault con Obsidian cerrado usando otras apps. El plugin detecta los cambios a través de Obsidian.
- No renombres un vault que ya sincroniza: el nombre del vault es la clave en Drive.
- Un iPhone solo sincroniza con Obsidian abierto. iOS no permite sincronizar en segundo plano.

# enlace-dinamico-whatsapp

Un formulario que se contesta por WhatsApp.

Alguien de adentro llena un diálogo corto —a quién invito y para qué—, la persona invitada recibe
un mensaje, y **el chat es el formulario**: lo que escriba y las fotos que mande quedan guardadas
donde tú decidas.

Nació del [PMU de la emergencia sísmica de Cali](https://github.com/Zenda-Holos-Produccion/pmu-sismo-prod),
para que un contratista parado en una obra pudiera entregar sus fotos sin instalar nada ni abrir
ninguna cuenta.

---

## El modelo: dos mitades, dos autores

Confundirlas es lo que vuelve inservible una abstracción así.

| | quién la llena | cuándo | qué lleva |
|---|---|---|---|
| **El diálogo** | quien invita | antes de que haya conversación | `campos`: los que hagan falta |
| **El chat** | la persona invitada | a lo largo del tiempo | informe (texto) y fotos |

Por eso **no existe un campo de tipo «foto» en el diálogo**: las fotos no las sube quien invita.
Meter las dos mitades en una sola lista de campos obligaría a marcar cada uno con «¿quién lo
llena?», que es la misma distinción escrita peor.

## Dónde se guarda lo decides tú

La librería sabe de WhatsApp y de la conversación. No sabe de Postgres, ni de Supabase, ni de S3.
Lo que hace falta para persistir entra por dos interfaces que tú implementas:

- **`Repositorio`** — crear el caso, registrar mensajes, guardar informe y fotos, cerrar.
- **`Almacen`** — dónde van los archivos.

Es lo que permite que el mismo formulario escriba en bases distintas.

## Instalación

```bash
npm install github:Zenda-Holos-Produccion/enlace-dinamico-whatsapp
```

No está publicado en npm: se instala desde git. El repositorio es **público**, así que no hace
falta ninguna credencial — ni en tu máquina, ni en CI, ni dentro de una imagen de Docker. Eso fue
deliberado: una dependencia privada obliga a meter un token en cada construcción, y es una forma
nueva de que falle un despliegue.

## Configuración

Son tres cosas, y conviene tenerlas en archivos separados porque cambian por motivos distintos:
el **canal** (credenciales, cambia cuando caduca un token), el **formulario** (qué se pregunta,
cambia cuando cambia el proceso) y los **adaptadores** (dónde se guarda, casi nunca cambia).

### 1 · El canal: `ConfigWhatsapp`

Todo lo que habla con Meta recibe este objeto. No lo lee de variables de entorno por su cuenta —
eso lo decide quien instala, que puede sacarlo de donde quiera:

```ts
// lib/whatsapp-config.ts
import type { ConfigWhatsapp } from "enlace-dinamico-whatsapp";

export function configWhatsapp(): ConfigWhatsapp {
  return {
    token: process.env.WHATSAPP_TOKEN ?? "",
    telefonoId: process.env.WHATSAPP_PHONE_ID ?? "",
    secretoDeAplicacion: process.env.WHATSAPP_APP_SECRET,
    tokenDeVerificacion: process.env.WHATSAPP_VERIFY_TOKEN,
    version: process.env.WHATSAPP_API_VERSION,   // opcional, por omisión v21.0
    indicativo: "57",                            // Colombia. 52 México, 34 España…
  };
}
```

| campo | qué es | de dónde sale |
|---|---|---|
| `token` | Token **permanente** de usuario de sistema | Business Settings → System users → Generate token, con `whatsapp_business_messaging`, `whatsapp_business_management` y `business_management` |
| `telefonoId` | El **id** del número emisor, no el número | Panel de la app → WhatsApp → API Setup |
| `secretoDeAplicacion` | Verifica la firma de los webhooks | Panel de la app → Settings → Basic → App Secret |
| `tokenDeVerificacion` | Lo inventas tú al registrar el webhook | Lo pones igual en los dos lados |
| `version` | Versión de la Graph API | Meta retira versiones cada par de años |
| `indicativo` | Prefijo del país, sin `+` | Se antepone al número guardado |

**El token del panel de API Setup dura 24 horas.** Si lo usas en producción, el día que caduque
nadie recibe su invitación y no hay error visible: solo casos que nadie atiende.

Si falta `token` o `telefonoId`, la librería **no revienta**: devuelve `ok:false` con el motivo y
tú decides —anotar el caso como «no enviado» para que alguien escriba a mano, en vez de perder la
invitación—. Si falta `secretoDeAplicacion`, `firmaValida` devuelve `false` siempre: falla
**cerrado**, que es lo correcto en un despliegue a medio configurar.

### 2 · El formulario

Una constante exportada. Es la **única** definición: de aquí salen los campos del diálogo, lo que
el chat recoge, las palabras de cierre y el cuerpo de la plantilla.

```ts
// lib/formularios/seguimiento-obra.ts
import type { Formulario } from "enlace-dinamico-whatsapp";

export const seguimientoDeObra: Formulario = {
  clave: "seguimiento-obra",
  boton: "Nuevo seguimiento",
  titulo: "Nuevo seguimiento",
  descripcion: "Se le escribe por WhatsApp y reporta desde ese mismo chat.",

  campos: [
    { clave: "nombre", etiqueta: "Nombre", tipo: "texto", requerido: true },
    { clave: "telefono", etiqueta: "Número celular", tipo: "telefono", requerido: true,
      ayuda: "Con o sin indicativo, con o sin espacios." },
    { clave: "nota", etiqueta: "Descripción", tipo: "texto_largo",
      marcador: "De qué obra se trata" },
  ],

  chat: {
    informe: { pide: true, obligatorioParaCerrar: true },
    fotos: { pide: true, minimoParaCerrar: 1 },
    palabrasDeCierre: ["listo", "terminé", "fin"],   // opcional
  },

  plantilla: {
    nombre: "pmu_seguimiento_obra",
    idioma: "es",
    categoria: "utility",
    cuerpo:
      "Hola {{1}}. Le escribimos por el seguimiento de {{2}}.\n\n" +
      "Por este mismo chat puede enviarnos fotos y escribir qué se hizo.\n\n" +
      "Cuando no quede nada por reportar, escriba LISTO.",
    variables: [{ campo: "nombre" }, { campo: "nota", siVacio: "una obra" }],
  },
};
```

Reglas que la configuración exige y que `validarPlantilla` comprueba:

- **Exactamente un campo de tipo `telefono`**: es por donde se escribe. Sin él, `invitar` se niega
  y dice por qué.
- **`siVacio` en toda variable que salga de un campo opcional.** Meta rechaza una plantilla con una
  variable vacía, y eso se descubre tarde: con la plantilla ya aprobada y el mensaje que no sale.
- **No hay campo de tipo «foto».** Las fotos no las sube quien invita; las manda la persona, por el
  chat. Eso se configura en `chat`, no en `campos`.

### 3 · Los adaptadores: dónde se guarda

Dos objetos que implementas tú. Es la frontera entre la librería y tu base, y conviene que viva en
un solo archivo: si algún día cambias de base, se reescribe ese y nada más.

```ts
// lib/formularios/adaptadores.ts
import type { Almacen, Repositorio } from "enlace-dinamico-whatsapp";

export function repositorio(db: TuBase): Repositorio {
  return {
    crearCaso: async ({ formulario, telefono, valores }) => { /* … */ },
    casoAbiertoDe: async (telefono) => { /* … o null */ },

    // `false` si el wamid YA estaba. Es la pieza contra los duplicados, y esa
    // unicidad tiene que vivir en la base —un índice único—, no en memoria:
    // dos instancias del servidor reciben reintentos distintos.
    registrarMensaje: async (m) => { /* true si es nuevo */ },

    guardarInforme: async (casoId, texto) => { /* … */ },
    guardarFoto: async (casoId, foto) => { /* … */ },
    contar: async (casoId) => ({ informes: 0, fotos: 0 }),
    cerrarCaso: async (casoId) => { /* … */ },
    anotarEnvio: async (casoId, r) => { /* ok, wamid o error */ },
  };
}

export const almacen: Almacen = {
  async guardar({ bytes, contentType, prefijo }) {
    // Sube… y VUELVE A LEER el objeto para comparar tamaño y hash antes de
    // darlo por bueno. Ver «Lo que muerde».
    return { ruta, sha256, bytes: bytes.length };
  },
};
```

`contar` decide si se puede cerrar: la librería la llama cuando la persona escribe la palabra de
cierre y la compara con lo que pide `chat`.

## Uso

### El botón

```tsx
import { BotonFormularioWhatsapp } from "enlace-dinamico-whatsapp/react";
import { seguimientoDeObra } from "@/lib/formularios/seguimiento-obra";

<BotonFormularioWhatsapp
  formulario={seguimientoDeObra}
  clases={{ boton: "mi-boton", dialogo: "mi-dialogo", campo: "mi-campo" }}
  alEnviar={async (valores) => {
    const r = await fetch("/api/seguimiento", { method: "POST", body: JSON.stringify(valores) });
    return r.json();
  }}
/>
```

No trae diseño a propósito: cada elemento sale con un atributo `data-edw-*` y acepta una clase por
fuera, así que lo vistes con tu sistema sin pelearte con el suyo. Y no habla con ningún servidor:
`alEnviar` llama a **tu** ruta, que es donde viven tus permisos.

¿Ya tienes tu propio diálogo? Úsalo y recorre `formulario.campos` tú mismo: lo que importa es que
los campos salgan de la configuración y no estén escritos a mano. Es lo que hace el PMU.

### Invitar, desde tu ruta

```ts
import { invitar } from "enlace-dinamico-whatsapp";

const { caso, enviado, error } = await invitar(
  { whatsapp: configWhatsapp(), repositorio: repositorio(db), almacen },
  seguimientoDeObra,
  valores,
);
// 201 aunque `enviado` sea false: el caso QUEDÓ creado. Decir lo contrario
// hace que alguien lo cree otra vez.
```

### El webhook

```ts
import {
  extraerMensajes, firmaValida, procesarEntrante, respuestaDeVerificacion,
} from "enlace-dinamico-whatsapp";

const deps = { whatsapp: configWhatsapp(), repositorio: repositorio(db), almacen,
  acuses: {
    recibido: ({ conFoto }) => conFoto ? "Recibida y guardada." : "Anotado.",
    faltaParaCerrar: (f) => f.fotos > 0 ? "Antes de cerrar, mándeme una foto." : "Cuénteme qué se hizo.",
    cerrado: () => "Cerrado. Gracias.",
  } };

export async function GET(peticion: Request) {
  const r = respuestaDeVerificacion(configWhatsapp(), new URL(peticion.url).searchParams);
  return r.ok ? new Response(r.reto) : new Response("no", { status: 403 });
}

export async function POST(peticion: Request) {
  const cfg = configWhatsapp();
  const crudo = await peticion.text();                       // CRUDO, sin parsear
  if (!firmaValida(cfg, crudo, peticion.headers.get("x-hub-signature-256"))) {
    return new Response("firma inválida", { status: 403 });
  }
  for (const m of extraerMensajes(JSON.parse(crudo))) {
    try {
      await procesarEntrante(deps, seguimientoDeObra, m);
    } catch (e) {
      console.error(e);   // uno malo no puede dejar sin procesar a los demás
    }
  }
  return Response.json({ ok: true });                        // SIEMPRE 200
}
```

`acuses` es opcional: sin él no se le contesta nada a la persona. Van como texto libre, así que
solo funcionan dentro de la ventana de 24 horas que ella abrió al escribir — que es exactamente
cuando se usan.

### Comprobar la plantilla antes de que falle en producción

```ts
import { validarPlantilla, textoParaMeta, previsualizarPlantilla } from "enlace-dinamico-whatsapp";

expect(validarPlantilla(seguimientoDeObra)).toEqual([]);   // vacío es que está bien
console.log(textoParaMeta(seguimientoDeObra));             // para pegar en el formulario de Meta
previsualizarPlantilla(seguimientoDeObra, { nombre: "Armando", nota: "el bloque B" });
```

`validarPlantilla` comprueba que los huecos coincidan en número y orden con las variables, que
cada variable salga de un campo que exista, y las reglas de forma de Meta que se conocen: no
empezar ni terminar con una variable, no dos seguidas, el nombre en minúsculas, el cuerpo bajo
1024 caracteres.

El `cuerpo` es **opcional**, para no estorbar a quien ya tenga una plantilla aprobada por fuera.
Pero sin él `validarPlantilla` devuelve un aviso y no comprueba nada — y conviene saber la
diferencia entre «está bien» y «no se miró».

**Lo que esto no hace:** no somete la plantilla ni comprueba que la aprobada en Meta sea esta. Si
alguien la edita desde el panel, aquí no se entera. Comprobarlo de verdad exige la API de gestión,
que es otro permiso y otro token.

---

## Lo que muerde, y por qué está así

**La firma es la única puerta.** El webhook es una URL pública que escribe en tu base y no tiene
sesión que la proteja: quien llama es Meta, no una persona. Sin comprobar la firma, cualquiera que
conozca la dirección puede inventar respuestas. Y se calcula sobre el **cuerpo crudo**: si parseas
el JSON y lo vuelves a serializar para firmarlo, un espacio tumba la comprobación.

Si falta el secreto, `firmaValida` devuelve `false`. Falla cerrado a propósito — un despliegue a
medio configurar es justo cuando tienta dejarlo pasar «por ahora».

**Meta reintenta.** Si tu webhook no responde `200` a tiempo, la misma entrega llega otra vez. Por
eso `registrarMensaje` devuelve `false` cuando el `wamid` ya estaba, y por eso esa unicidad tiene
que vivir en tu base y no en memoria: dos instancias del servidor reciben reintentos distintos.
Y por eso respondes `200` incluso cuando algo falló al procesar — reintentar lo ya guardado no
arregla nada.

**Las fotos se bajan en el acto.** La URL que da Meta está firmada y caduca en minutos. Diferirla
a una cola es cambiar un problema por otro peor: una foto que ya no se puede recuperar.

**Relee lo que subas.** `Almacen` no lo impone porque no puede, pero quien lo implemente debería
volver a leer el objeto y comparar tamaño y hash antes de darlo por bueno. En el proyecto donde
nació esto se perdieron 88 fotografías de 23 reportes porque el archivo se daba por subido sin
releerlo: todo respondía 200, la fila se escribía, y el daño apareció semanas después.

**La ventana de 24 horas.** Fuera de las 24 horas desde el último mensaje de la persona, Meta solo
admite plantillas aprobadas. Por eso la invitación es plantilla y los acuses son texto: van dentro
de la ventana que ella abrió al escribir.

**El token del panel dura 24 horas.** Usa uno permanente de usuario de sistema. Con el temporal,
el día que caduque nadie recibe su invitación y no hay error visible: solo casos que nadie
atiende.

**Cerrar se compara con el mensaje entero.** «Listo, mañana sigo» contiene «listo» y es lo
contrario de un cierre: cerrar ahí le quita a la persona la forma de seguir reportando, y reabrir
no está en su mano.

## Datos personales

Lo que pasa por aquí lo procesa Meta: los números, los textos y **las fotos**, que quedan en sus
servidores hasta que se descargan. Si lo que recoges son datos de personas, eso obliga a su
autorización de tratamiento y a un contrato de transmisión con Meta. La librería no puede
resolverlo por ti.

## Estado

`0.1.0`. Un solo consumidor y todavía sin correr en producción: la interfaz puede cambiar cuando
aparezca el segundo, que es el que de verdad la decide.

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

Es privado, así que se instala desde git:

```bash
npm install github:Zenda-Holos-Produccion/enlace-dinamico-whatsapp
```

Tu máquina y tu CI necesitan poder clonarlo. Si construyes dentro de Docker, el `npm install` de
la imagen también.

## Uso

### 1 · Declara el formulario

```ts
import type { Formulario } from "enlace-dinamico-whatsapp";

export const seguimientoDeObra: Formulario = {
  clave: "seguimiento-obra",
  boton: "Nuevo seguimiento",
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
  },
  plantilla: {
    nombre: "pmu_seguimiento_obra",
    categoria: "utility",
    cuerpo:
      "Hola {{1}}. Le escribimos del PMU por el seguimiento de {{2}}.\n\n" +
      "Por este mismo chat puede enviarnos fotos y escribir qué se hizo.\n\n" +
      "Cuando no quede nada por reportar, escriba LISTO.",
    variables: [{ campo: "nombre" }, { campo: "nota", siVacio: "una obra" }],
  },
};
```

`siVacio` no es un adorno: **Meta rechaza una plantilla con una variable vacía**, y eso se
descubre tarde — con la plantilla ya aprobada y el mensaje que no sale.

### La plantilla la escribes tú, y por eso se comprueba

Una plantilla es un texto que **Meta aprueba palabra por palabra**, con huecos `{{1}}`, `{{2}}`…
Si tu formulario declara dos variables y la plantilla aprobada tiene tres, Meta rechaza el envío
— y eso pasa **en producción, al invitar**, donde nadie lo ve: el caso queda creado y la persona
nunca recibe nada. Lo que se nota, semanas después, es «ese caso no lo atendió nadie».

Por eso el cuerpo se declara aquí y no solo el nombre:

```ts
import { validarPlantilla, textoParaMeta, previsualizarPlantilla } from "enlace-dinamico-whatsapp";

// En una prueba, o al arrancar. Vacío es que está bien.
expect(validarPlantilla(seguimientoDeObra)).toEqual([]);

// Lo que se pega en el formulario de Meta, con qué va en cada hueco.
console.log(textoParaMeta(seguimientoDeObra));

// Lo que va a recibir la persona, para enseñárselo a quien aprueba el texto.
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

### 2 · El botón

```tsx
import { BotonFormularioWhatsapp } from "enlace-dinamico-whatsapp/react";

<BotonFormularioWhatsapp
  formulario={seguimientoDeObra}
  clases={{ boton: "mi-boton", dialogo: "mi-dialogo", campo: "mi-campo" }}
  alEnviar={async (valores) => {
    const r = await fetch("/api/seguimiento", { method: "POST", body: JSON.stringify(valores) });
    return r.json();
  }}
/>
```

No trae diseño a propósito: cada elemento sale con un atributo `data-edw-*` y acepta una clase
por fuera, así que lo vistes con tu sistema sin pelearte con el suyo. Y no habla con ningún
servidor: `alEnviar` llama a **tu** ruta, que es donde viven tus permisos.

### 3 · El webhook

```ts
import { extraerMensajes, firmaValida, procesarEntrante, respuestaDeVerificacion } from "enlace-dinamico-whatsapp";

export async function GET(peticion: Request) {
  const r = respuestaDeVerificacion(cfg, new URL(peticion.url).searchParams);
  return r.ok ? new Response(r.reto) : new Response("no", { status: 403 });
}

export async function POST(peticion: Request) {
  const crudo = await peticion.text();                       // CRUDO, sin parsear
  if (!firmaValida(cfg, crudo, peticion.headers.get("x-hub-signature-256"))) {
    return new Response("firma inválida", { status: 403 });
  }
  for (const m of extraerMensajes(JSON.parse(crudo))) {
    await procesarEntrante({ whatsapp: cfg, repositorio, almacen }, seguimientoDeObra, m);
  }
  return Response.json({ ok: true });                        // SIEMPRE 200
}
```

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

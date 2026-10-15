import { describe, expect, it, vi } from "vitest";
import { esCierre, normalizarTelefono, procesarEntrante, invitar } from "../src/conversacion.js";
import { extraerMensajes, firmaValida } from "../src/whatsapp.js";
import { createHmac } from "node:crypto";
import type { Almacen, Caso, Formulario, Repositorio } from "../src/tipos.js";

/**
 * Lo que se prueba aquí es lo que puede equivocarse en silencio: reconocer el
 * cierre, reconocer el número, no duplicar lo que Meta reintenta, y no dejar
 * entrar a quien no firmó.
 */

const FORMULARIO: Formulario = {
  clave: "seguimiento",
  boton: "Nuevo seguimiento",
  campos: [
    { clave: "nombre", etiqueta: "Nombre", tipo: "texto", requerido: true },
    { clave: "telefono", etiqueta: "Celular", tipo: "telefono", requerido: true },
  ],
  chat: { informe: { pide: true, obligatorioParaCerrar: true }, fotos: { pide: true, minimoParaCerrar: 1 } },
  plantilla: { nombre: "p", variables: [{ campo: "nombre" }] },
};

const whatsapp = { token: "t", telefonoId: "1", indicativo: "57", secretoDeAplicacion: "s" };

function repositorioFalso(caso: Caso | null) {
  const vistos = new Set<string>();
  const estado = { informes: 0, fotos: 0, cerrado: false };
  const repo: Repositorio = {
    crearCaso: async (e) => ({ id: "c1", formulario: e.formulario, telefono: e.telefono, valores: e.valores, estado: "invitado" }),
    casoAbiertoDe: async () => caso,
    registrarMensaje: async (m) => (vistos.has(m.wamid) ? false : (vistos.add(m.wamid), true)),
    guardarInforme: async () => { estado.informes += 1; },
    guardarFoto: async () => { estado.fotos += 1; },
    contar: async () => ({ informes: estado.informes, fotos: estado.fotos }),
    cerrarCaso: async () => { estado.cerrado = true; },
    anotarEnvio: async () => {},
  };
  return { repo, estado };
}

const almacen: Almacen = {
  guardar: async () => ({ ruta: "x/1.jpg", sha256: "a".repeat(64), bytes: 10 }),
};

const CASO: Caso = { id: "c1", formulario: "seguimiento", telefono: "3001234567", valores: {}, estado: "en_curso" };

describe("reconocer que la persona terminó", () => {
  it("1 · reconoce las formas de decirlo", () => {
    for (const t of ["listo", "LISTO", " Listo ", "terminé", "Terminado", "fin", "listo."]) {
      expect(esCierre(t), `no reconoció «${t}»`).toBe(true);
    }
  });

  it("2 · NO cierra con una frase que solo contiene la palabra", () => {
    // Cerrar ahí le quita a la persona la forma de seguir reportando, y
    // reabrir no está en su mano.
    for (const t of ["Listo, mañana sigo con el segundo piso", "ya quedó listo el muro pero falta el techo"]) {
      expect(esCierre(t), `cerró con «${t}»`).toBe(false);
    }
  });

  it("3 · se pueden cambiar las palabras por formulario", () => {
    expect(esCierre("acabé", ["acabé", "ya"])).toBe(true);
    expect(esCierre("listo", ["acabé", "ya"]), "las de por omisión dejan de valer").toBe(false);
  });
});

describe("el número", () => {
  it("4 · se guarda sin indicativo, venga como venga", () => {
    expect(normalizarTelefono("573001234567", "57")).toBe("3001234567");
    expect(normalizarTelefono("3001234567", "57")).toBe("3001234567");
    // Si unos se guardaran con indicativo y otros sin él, buscar el caso
    // abierto por teléfono fallaría la mitad de las veces.
    expect(normalizarTelefono("5215512345678", "52")).toBe("15512345678");
  });
});

describe("lo que Meta reintenta no se guarda dos veces", () => {
  it("5 · el mismo wamid, dos veces, se procesa una", async () => {
    const { repo, estado } = repositorioFalso(CASO);
    const dep = { whatsapp, repositorio: repo, almacen };
    const m = { wamid: "w1", de: "573001234567", tipo: "text" as const, texto: "Fundimos la placa" };

    expect((await procesarEntrante(dep, FORMULARIO, m)).estado).toBe("guardado");
    expect((await procesarEntrante(dep, FORMULARIO, m)).estado).toBe("repetido");
    expect(estado.informes, "el informe se guardó una sola vez").toBe(1);
  });

  it("6 · a un número sin caso abierto no se le contesta", async () => {
    const { repo } = repositorioFalso(null);
    const r = await procesarEntrante({ whatsapp, repositorio: repo, almacen }, FORMULARIO, {
      wamid: "w9", de: "573009999999", tipo: "text", texto: "hola",
    });
    expect(r.estado).toBe("sin_caso");
  });
});

describe("cerrar exige lo que el formulario pida", () => {
  it("7 · sin informe ni foto, no cierra", async () => {
    const { repo, estado } = repositorioFalso(CASO);
    const r = await procesarEntrante({ whatsapp, repositorio: repo, almacen }, FORMULARIO, {
      wamid: "w2", de: "573001234567", tipo: "text", texto: "listo",
    });
    expect(r.estado).toBe("ignorado");
    // Un caso vacío cerrado parece atendido y no lo está.
    expect(estado.cerrado).toBe(false);
  });
});

describe("invitar", () => {
  it("8 · sin campo de teléfono, se niega y dice por qué", async () => {
    const { repo } = repositorioFalso(null);
    const sinTelefono = { ...FORMULARIO, campos: [FORMULARIO.campos[0]!] };
    await expect(
      invitar({ whatsapp, repositorio: repo, almacen }, sinTelefono, { nombre: "A" }),
    ).rejects.toThrow(/no declara un campo de tipo «telefono»/);
  });

  it("9 · una variable vacía se rellena: Meta rechaza las vacías", async () => {
    const { repo } = repositorioFalso(null);
    const espia = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "w-out" }] }), { status: 200 }),
    );
    try {
      const f = { ...FORMULARIO, plantilla: { nombre: "p", variables: [{ campo: "nota", siVacio: "una obra" }] } };
      await invitar({ whatsapp, repositorio: repo, almacen }, f, { nombre: "A", telefono: "3001234567" });
      const cuerpo = JSON.parse((espia.mock.calls[0]?.[1] as RequestInit).body as string);
      expect(cuerpo.template.components[0].parameters[0].text).toBe("una obra");
    } finally {
      espia.mockRestore();
    }
  });
});

describe("la firma del webhook", () => {
  const cuerpo = '{ "object": "whatsapp_business_account" }';
  const firmar = (c: string, s = "s") => "sha256=" + createHmac("sha256", s).update(c, "utf8").digest("hex");

  it("10 · acepta la buena y rechaza la ajena", () => {
    expect(firmaValida(whatsapp, cuerpo, firmar(cuerpo))).toBe(true);
    expect(firmaValida(whatsapp, cuerpo, firmar(cuerpo, "otro"))).toBe(false);
  });

  it("11 · SIN secreto configurado rechaza; no deja pasar", () => {
    // Es exactamente cuando resulta tentador dejarlo abierto «por ahora».
    expect(firmaValida({ ...whatsapp, secretoDeAplicacion: undefined }, cuerpo, firmar(cuerpo))).toBe(false);
  });

  it("12 · una firma de largo raro no revienta", () => {
    expect(() => firmaValida(whatsapp, cuerpo, "sha256=abcd")).not.toThrow();
    expect(firmaValida(whatsapp, cuerpo, "sha256=abcd")).toBe(false);
  });
});

describe("leer la entrega de Meta", () => {
  it("13 · los avisos de entrega y lectura NO son mensajes", () => {
    // Vienen por el mismo webhook. Tratarlos como mensajes crearía una
    // respuesta vacía cada vez que alguien abre el chat.
    expect(extraerMensajes({ entry: [{ changes: [{ value: { statuses: [{ id: "x" }] } }] }] })).toEqual([]);
  });

  it("14 · una imagen conserva su pie de foto", () => {
    const [m] = extraerMensajes({
      entry: [{ changes: [{ value: { messages: [{ id: "w", from: "57300", type: "image", image: { id: "m1", caption: "Muro norte" } }] } }] }],
    });
    expect(m!.medioId).toBe("m1");
    expect(m!.texto).toBe("Muro norte");
  });

  it("15 · una entrega rara devuelve vacío en vez de reventar", () => {
    for (const basura of [null, {}, { entry: null }, { entry: [{}] }]) {
      expect(() => extraerMensajes(basura)).not.toThrow();
      expect(extraerMensajes(basura)).toEqual([]);
    }
  });
});

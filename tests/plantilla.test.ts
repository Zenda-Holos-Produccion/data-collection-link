import { describe, expect, it } from "vitest";
import { previsualizarPlantilla, textoParaMeta, validarPlantilla } from "../src/plantilla.js";
import type { Formulario } from "../src/tipos.js";

/**
 * La plantilla la escribe quien instala, y por eso se comprueba.
 *
 * EL DEFECTO QUE ESTO CAZA
 * ------------------------
 * Si el formulario declara dos variables y la plantilla aprobada en Meta
 * tiene tres, Meta rechaza el envío. Eso pasa **en producción, al invitar**,
 * donde nadie lo ve: el caso queda creado y la persona nunca recibe nada, así
 * que lo que se nota semanas después es «ese seguimiento no lo atendió
 * nadie». Declarando el cuerpo, el desajuste se caza en una prueba.
 */

const base: Formulario = {
  clave: "f",
  boton: "Invitar",
  campos: [
    { clave: "nombre", etiqueta: "Nombre", tipo: "texto" },
    { clave: "telefono", etiqueta: "Celular", tipo: "telefono" },
    { clave: "obra", etiqueta: "Obra", tipo: "texto" },
  ],
  chat: {},
  plantilla: {
    nombre: "pmu_seguimiento_obra",
    cuerpo: "Hola {{1}}. Le escribimos por el seguimiento de {{2}}.\n\nPuede responder por aquí.",
    variables: [{ campo: "nombre" }, { campo: "obra", siVacio: "una obra" }],
  },
};

const con = (p: Partial<Formulario["plantilla"]>): Formulario => ({
  ...base,
  plantilla: { ...base.plantilla, ...p },
});

describe("una plantilla bien puesta", () => {
  it("1 · no tiene nada que decir", () => {
    expect(validarPlantilla(base)).toEqual([]);
  });

  it("2 · se puede previsualizar con valores de verdad", () => {
    const texto = previsualizarPlantilla(base, { nombre: "Armando", obra: "el bloque B" });
    expect(texto).toContain("Hola Armando.");
    expect(texto).toContain("seguimiento de el bloque B");
  });

  it("3 · un campo vacío usa su respaldo, porque Meta rechaza los vacíos", () => {
    expect(previsualizarPlantilla(base, { nombre: "Armando" })).toContain("de una obra");
  });
});

describe("los desajustes que Meta solo canta al enviar", () => {
  it("4 · huecos de más o de menos", () => {
    const menos = validarPlantilla(con({ cuerpo: "Hola {{1}}, buenas." }));
    expect(menos.map((p) => p.regla)).toContain("cuantas");
    expect(menos[0]!.detalle).toMatch(/1 hueco\(s\) y se declararon 2/);

    const mas = validarPlantilla(con({ cuerpo: "Hola {{1}} por {{2}} en {{3}}, gracias." }));
    expect(mas.map((p) => p.regla)).toContain("cuantas");
  });

  it("5 · huecos fuera de orden o repetidos", () => {
    expect(validarPlantilla(con({ cuerpo: "Hola {{2}} por {{1}}, gracias." })).map((p) => p.regla)).toContain("orden");
    expect(validarPlantilla(con({ cuerpo: "Hola {{1}} por {{1}}, gracias." })).map((p) => p.regla)).toContain("orden");
  });

  it("6 · una variable que apunta a un campo inexistente", () => {
    // Llegaría vacía, y Meta rechaza las variables vacías.
    const r = validarPlantilla(con({ variables: [{ campo: "nombre" }, { campo: "inventado" }] }));
    expect(r.map((p) => p.regla)).toContain("variable_sin_campo");
    expect(r.find((p) => p.regla === "variable_sin_campo")!.detalle).toContain("inventado");
  });
});

describe("las reglas de forma de Meta", () => {
  it("7 · no puede empezar ni terminar con una variable", () => {
    expect(validarPlantilla(con({ cuerpo: "{{1}} le escribimos por {{2}} hoy." })).map((p) => p.regla)).toContain("empieza_con_hueco");
    expect(validarPlantilla(con({ cuerpo: "Hola {{1}}, se trata de {{2}}" })).map((p) => p.regla)).toContain("termina_con_hueco");
  });

  it("8 · dos variables seguidas sin texto entre ellas", () => {
    expect(validarPlantilla(con({ cuerpo: "Hola {{1}} {{2}}, gracias." })).map((p) => p.regla)).toContain("huecos_pegados");
  });

  it("9 · el nombre solo admite minúsculas, números y guiones bajos", () => {
    expect(validarPlantilla(con({ nombre: "PMU Seguimiento" })).map((p) => p.regla)).toContain("nombre");
  });
});

describe("sin cuerpo declarado", () => {
  it("10 · no es un error, pero se avisa de que no se comprobó nada", () => {
    // Se puede usar una plantilla aprobada por fuera. Lo que no se puede es
    // creer que está comprobada.
    const r = validarPlantilla(con({ cuerpo: undefined }));
    expect(r.map((p) => p.regla)).toEqual(["sin_cuerpo"]);
    expect(r[0]!.detalle).toContain("en producción");
  });
});

describe("lo que se le pasa a quien somete la plantilla", () => {
  it("11 · el cuerpo y qué va en cada hueco", () => {
    const m = textoParaMeta(base);
    expect(m.nombre).toBe("pmu_seguimiento_obra");
    expect(m.idioma).toBe("es");
    // Utility y no Marketing: continúa una gestión abierta, no es publicidad.
    // Marketing cuesta más y la persona lo puede tener bloqueado.
    expect(m.categoria).toBe("utility");
    expect(m.ejemplos).toEqual([
      { hueco: "{{1}}", campo: "nombre", siVacio: undefined },
      { hueco: "{{2}}", campo: "obra", siVacio: "una obra" },
    ]);
  });
});

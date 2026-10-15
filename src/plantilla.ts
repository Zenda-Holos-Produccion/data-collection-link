import type { Formulario } from "./tipos.js";

/**
 * La plantilla la escribe quien instala, y aquí se comprueba.
 *
 * POR QUÉ NO BASTA CON EL NOMBRE
 * ------------------------------
 * Una plantilla de WhatsApp es un texto que **Meta aprueba palabra por
 * palabra**, con huecos `{{1}}`, `{{2}}`… Si el formulario declara dos
 * variables y la plantilla aprobada tiene tres, Meta rechaza el envío — y eso
 * pasa **en producción, al invitar**, donde nadie lo ve: el caso queda creado
 * y la persona nunca recibe nada.
 *
 * Declarando también el cuerpo, ese desajuste se caza antes: en una prueba, o
 * al arrancar, o en el guion que somete la plantilla.
 *
 * LO QUE ESTO **NO** PUEDE HACER
 * ------------------------------
 * No somete la plantilla ni comprueba que la aprobada en Meta sea esta. Si
 * alguien la edita desde el panel, aquí no se entera: Meta la vuelve a
 * revisar y el cuerpo declarado queda viejo. Comprobar eso de verdad exige
 * consultar la API de gestión, y ese es otro permiso y otro token.
 */

export type ProblemaDePlantilla = { regla: string; detalle: string };

/** Los huecos del cuerpo, en el orden en que aparecen. */
function huecos(cuerpo: string): number[] {
  return [...cuerpo.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
}

/**
 * Comprueba el cuerpo contra las variables declaradas y contra las reglas de
 * Meta que se conocen. Devuelve la lista de problemas: vacía es que está bien.
 */
export function validarPlantilla(formulario: Formulario): ProblemaDePlantilla[] {
  const p = formulario.plantilla;
  const problemas: ProblemaDePlantilla[] = [];

  if (!/^[a-z0-9_]{1,512}$/.test(p.nombre)) {
    problemas.push({
      regla: "nombre",
      detalle: `«${p.nombre}» no sirve: Meta solo admite minúsculas, números y guiones bajos.`,
    });
  }

  // Cada variable tiene que salir de un campo que exista, o el valor llegaría
  // vacío y Meta rechaza las variables vacías.
  for (const v of p.variables) {
    if (!formulario.campos.some((c) => c.clave === v.campo)) {
      problemas.push({
        regla: "variable_sin_campo",
        detalle: `La variable apunta al campo «${v.campo}», que el formulario no declara.`,
      });
    }
  }

  if (!p.cuerpo) {
    // No es un error: se puede usar una plantilla aprobada por fuera. Pero sin
    // el cuerpo no hay nada que comprobar, y conviene que se sepa.
    problemas.push({
      regla: "sin_cuerpo",
      detalle:
        "No se declaró el cuerpo, así que no se puede comprobar que los huecos coincidan con las variables. El desajuste aparecería al invitar, en producción.",
    });
    return problemas;
  }

  const cuerpo = p.cuerpo.trim();
  const nums = huecos(cuerpo);

  if (cuerpo.length > 1024) {
    problemas.push({ regla: "largo", detalle: `El cuerpo tiene ${cuerpo.length} caracteres y el máximo son 1024.` });
  }

  if (nums.length !== p.variables.length) {
    problemas.push({
      regla: "cuantas",
      detalle: `El cuerpo tiene ${nums.length} hueco(s) y se declararon ${p.variables.length} variable(s). Meta rechaza el envío cuando no coinciden.`,
    });
  }

  // Ascendentes desde 1 y sin repetir: Meta lo exige.
  const esperado = nums.map((_, i) => i + 1);
  if (nums.join(",") !== esperado.join(",")) {
    problemas.push({
      regla: "orden",
      detalle: `Los huecos tienen que ir {{1}}, {{2}}… en orden y sin repetirse. Están así: ${nums.map((n) => `{{${n}}}`).join(" ")}.`,
    });
  }

  if (/^\s*\{\{/.test(cuerpo)) {
    problemas.push({ regla: "empieza_con_hueco", detalle: "El cuerpo no puede empezar con una variable." });
  }
  if (/\}\}\s*$/.test(cuerpo)) {
    problemas.push({ regla: "termina_con_hueco", detalle: "El cuerpo no puede terminar con una variable." });
  }
  if (/\}\}[\s]*\{\{/.test(cuerpo)) {
    problemas.push({
      regla: "huecos_pegados",
      detalle: "Dos variables no pueden ir seguidas sin texto entre ellas.",
    });
  }

  return problemas;
}

/**
 * El cuerpo listo para pegar en el formulario de Meta, con la lista de qué va
 * en cada hueco. Es lo que se le pasa a quien somete la plantilla.
 */
export function textoParaMeta(formulario: Formulario): {
  nombre: string;
  idioma: string;
  categoria: string;
  cuerpo: string;
  ejemplos: { hueco: string; campo: string; siVacio?: string }[];
} {
  const p = formulario.plantilla;
  return {
    nombre: p.nombre,
    idioma: p.idioma ?? "es",
    // Utility y no Marketing: esto continúa una gestión ya abierta con la
    // persona, no es publicidad. Marketing cuesta más y se puede bloquear.
    categoria: p.categoria ?? "utility",
    cuerpo: (p.cuerpo ?? "").trim(),
    ejemplos: p.variables.map((v, i) => ({
      hueco: `{{${i + 1}}}`,
      campo: v.campo,
      siVacio: v.siVacio,
    })),
  };
}

/**
 * Qué va a recibir la persona, con valores de verdad. Para mirarlo antes de
 * mandar nada — y para enseñárselo a quien aprueba el texto.
 */
export function previsualizarPlantilla(
  formulario: Formulario,
  valores: Record<string, string>,
): string {
  const p = formulario.plantilla;
  let texto = (p.cuerpo ?? "").trim();
  p.variables.forEach((v, i) => {
    const valor = (valores[v.campo] ?? "").trim() || v.siVacio || "—";
    texto = texto.replace(new RegExp(`\\{\\{\\s*${i + 1}\\s*\\}\\}`, "g"), valor);
  });
  return texto;
}

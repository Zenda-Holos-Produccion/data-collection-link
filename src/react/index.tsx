"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CampoDialogo, Formulario } from "../tipos.js";

/**
 * El botón y su diálogo, con los campos que diga la configuración.
 *
 * NO TRAE DISEÑO, A PROPÓSITO
 * ---------------------------
 * Una librería que impone su estilo obliga a pelearse con ella. Cada elemento
 * sale con un atributo `data-edw-*` y acepta una clase por fuera, así que
 * quien la instala la viste con su propio sistema —variables, Tailwind, lo que
 * sea— sin sobrescribir nada.
 *
 * QUIÉN HABLA CON EL SERVIDOR
 * ---------------------------
 * Esto no. `alEnviar` lo pone quien instala, y ahí llama a SU ruta, que es
 * donde viven sus permisos y sus secretos. Una librería de interfaz que
 * llamara sola a una API tendría que saber de autenticación, y eso no es
 * asunto suyo.
 */

export type ResultadoEnvio = { enviado: boolean; error?: string | null };

export function BotonFormularioWhatsapp({
  formulario,
  alEnviar,
  clases,
  children,
}: {
  formulario: Formulario;
  /** Manda los valores a tu servidor y devuelve si el WhatsApp salió. */
  alEnviar: (valores: Record<string, string>) => Promise<ResultadoEnvio>;
  clases?: Partial<
    Record<
      "boton" | "fondo" | "dialogo" | "titulo" | "descripcion" | "campo" | "etiqueta" | "ayuda" | "error" | "exito" | "acciones" | "enviar" | "cancelar",
      string
    >
  >;
  /** Un icono, o lo que vaya antes del rótulo del botón. */
  children?: ReactNode;
}) {
  const [abierto, setAbierto] = useState(false);
  const [valores, setValores] = useState<Record<string, string>>({});
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<ResultadoEnvio | null>(null);

  function cerrar() {
    setAbierto(false);
    setValores({});
    setError(null);
    setResultado(null);
    setEnviando(false);
  }

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    try {
      setResultado(await alEnviar(valores));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo enviar.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <>
      <button type="button" data-edw="boton" className={clases?.boton} onClick={() => setAbierto(true)}>
        {children}
        {formulario.boton}
      </button>

      {abierto ? (
        <Dialogo
          titulo={resultado ? "Listo" : (formulario.titulo ?? formulario.boton)}
          descripcion={resultado ? undefined : formulario.descripcion}
          alCerrar={cerrar}
          clases={clases}
        >
          {resultado ? (
            <div data-edw="resultado">
              {resultado.enviado ? (
                <p data-edw="exito" className={clases?.exito}>
                  Mensaje enviado. La persona puede responder por ese chat.
                </p>
              ) : (
                <>
                  <p data-edw="error" className={clases?.error}>
                    Se guardó, pero el mensaje no se pudo enviar. Escríbale usted.
                  </p>
                  {/* Lo que contestó Meta, tal cual: dice si es la plantilla sin
                      aprobar, el número fuera de la lista de pruebas o el token
                      vencido, y sin eso no se puede arreglar. */}
                  {resultado.error ? <p data-edw="detalle">{resultado.error}</p> : null}
                </>
              )}
              <div data-edw="acciones" className={clases?.acciones}>
                <button type="button" className={clases?.cancelar} onClick={cerrar}>
                  Cerrar
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={enviar} data-edw="formulario">
              {formulario.campos.map((campo) => (
                <Campo
                  key={campo.clave}
                  campo={campo}
                  valor={valores[campo.clave] ?? ""}
                  alCambiar={(v) => setValores((x) => ({ ...x, [campo.clave]: v }))}
                  clases={clases}
                />
              ))}

              {error ? (
                <p role="alert" data-edw="error" className={clases?.error}>
                  {error}
                </p>
              ) : null}

              <div data-edw="acciones" className={clases?.acciones}>
                <button type="button" className={clases?.cancelar} onClick={cerrar}>
                  Cancelar
                </button>
                <button type="submit" disabled={enviando} className={clases?.enviar}>
                  {enviando ? "Enviando…" : "Enviar por WhatsApp"}
                </button>
              </div>
            </form>
          )}
        </Dialogo>
      ) : null}
    </>
  );
}

function Campo({
  campo,
  valor,
  alCambiar,
  clases,
}: {
  campo: CampoDialogo;
  valor: string;
  alCambiar: (v: string) => void;
  clases?: Record<string, string | undefined>;
}) {
  const id = `edw-${campo.clave}`;
  const comunes = {
    id,
    value: valor,
    required: campo.requerido,
    placeholder: campo.marcador,
    maxLength: campo.maximo,
    "aria-describedby": campo.ayuda ? `${id}-ayuda` : undefined,
    className: clases?.campo,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => alCambiar(e.target.value),
  };
  return (
    <div data-edw="campo" data-edw-tipo={campo.tipo}>
      <label htmlFor={id} data-edw="etiqueta" className={clases?.etiqueta}>
        {campo.etiqueta}
      </label>
      {campo.tipo === "texto_largo" ? (
        <textarea {...comunes} rows={3} />
      ) : (
        <input {...comunes} inputMode={campo.tipo === "telefono" ? "tel" : undefined} />
      )}
      {campo.ayuda ? (
        <p id={`${id}-ayuda`} data-edw="ayuda" className={clases?.ayuda}>
          {campo.ayuda}
        </p>
      ) : null}
    </div>
  );
}

function Dialogo({
  titulo,
  descripcion,
  alCerrar,
  clases,
  children,
}: {
  titulo: string;
  descripcion?: string;
  alCerrar: () => void;
  clases?: Record<string, string | undefined>;
  children: ReactNode;
}) {
  const caja = useRef<HTMLDivElement>(null);

  /**
   * `alCerrar` en una referencia, y el efecto SIN dependencias.
   *
   * Si el efecto dependiera de `alCerrar` —que quien usa esto va a pasar como
   * función escrita en el sitio, nueva en cada render— cada tecla lo rehace y
   * `caja.current?.focus()` se lleva el cursor al contenedor: se escribe una
   * letra y el foco se va. Es un defecto real, visto y medido en el proyecto
   * donde nació esta librería.
   */
  const alCerrarRef = useRef(alCerrar);
  useEffect(() => {
    alCerrarRef.current = alCerrar;
  }, [alCerrar]);

  useEffect(() => {
    caja.current?.focus();
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") alCerrarRef.current();
    };
    document.addEventListener("keydown", tecla);
    return () => document.removeEventListener("keydown", tecla);
  }, []);

  return (
    <div data-edw="fondo" className={clases?.fondo}>
      <div
        ref={caja}
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        tabIndex={-1}
        data-edw="dialogo"
        className={clases?.dialogo}
      >
        <h2 data-edw="titulo" className={clases?.titulo}>
          {titulo}
        </h2>
        {descripcion ? (
          <p data-edw="descripcion" className={clases?.descripcion}>
            {descripcion}
          </p>
        ) : null}
        {children}
      </div>
    </div>
  );
}

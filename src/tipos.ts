/**
 * El modelo de un formulario conversacional por WhatsApp.
 *
 * LA IDEA EN UNA FRASE
 * --------------------
 * Alguien de adentro llena un diálogo corto —a quién invito y para qué—, la
 * persona invitada recibe un WhatsApp, y **el chat es el formulario**: lo que
 * escriba y las fotos que mande quedan guardadas donde quien instala esta
 * librería decida.
 *
 * LAS DOS MITADES, QUE SE CONFIGURAN APARTE
 * -----------------------------------------
 * Un formulario tiene dos momentos y dos autores, y confundirlos es el error
 * que vuelve inservible una abstracción así:
 *
 *   1. **El diálogo** lo llena quien invita, antes de que exista conversación.
 *      Son `campos`: cuantos haga falta, con su etiqueta y su tipo. Sirven
 *      para saber a quién se invita y de qué va el caso.
 *   2. **El chat** lo llena la persona invitada, a lo largo del tiempo. Ahí no
 *      hay campos: hay dos cosas que una persona puede mandar por WhatsApp
 *      —texto y fotos— y la configuración dice cuáles se piden y cuáles hacen
 *      falta para dar el caso por cerrado.
 *
 * Por eso no existe «un campo de tipo foto» en el diálogo: las fotos no las
 * manda quien invita. Mezclar las dos mitades en una sola lista de campos
 * obligaría a marcar cada uno con «¿quién lo llena?», que es la misma
 * distinción escrita peor.
 *
 * DÓNDE SE GUARDA: LO DECIDE QUIEN INSTALA
 * ----------------------------------------
 * Esta librería no sabe de Postgres, ni de Supabase, ni de S3. Sabe de
 * WhatsApp y de la conversación. Lo que hace falta para persistir se pide por
 * dos interfaces —`Repositorio` y `Almacen`— que implementa quien la usa.
 * Es lo que permite que el mismo formulario escriba en bases distintas.
 */

/** Un campo del diálogo que llena quien invita. */
export type CampoDialogo = {
  /** Con qué nombre llega el valor al repositorio. */
  clave: string;
  etiqueta: string;
  /**
   * `telefono` es obligatorio y solo puede haber uno: es por donde se escribe.
   * `texto` y `texto_largo` son lo demás. No hay tipo `foto`: en el diálogo no
   * se suben fotos — las manda la persona invitada, por el chat.
   */
  tipo: "telefono" | "texto" | "texto_largo";
  requerido?: boolean;
  /** La ayuda bajo el campo. Para decir el formato esperado, no para repetir la etiqueta. */
  ayuda?: string;
  /** El texto gris de dentro del campo. */
  marcador?: string;
  maximo?: number;
};

/** Qué recoge el chat, y qué hace falta para poder cerrar. */
export type LoQueRecogeElChat = {
  /** Texto libre que la persona escribe. Lo que aquí se llama «informe». */
  informe?: {
    pide: boolean;
    /** Si hace falta al menos uno para cerrar el caso. */
    obligatorioParaCerrar?: boolean;
  };
  fotos?: {
    pide: boolean;
    /** Cuántas hacen falta como mínimo para cerrar. `0` = ninguna. */
    minimoParaCerrar?: number;
  };
  /**
   * Las palabras con las que la persona da el caso por terminado.
   *
   * Se compara el mensaje ENTERO, sin tildes ni signos, no si lo contiene:
   * «Listo, mañana sigo» contiene «listo» y es lo contrario de un cierre.
   */
  palabrasDeCierre?: string[];
};

export type Formulario = {
  /** Identifica a este formulario en el repositorio. */
  clave: string;
  /** El rótulo del botón que lo abre. Lo decide quien instala. */
  boton: string;
  /** El título del diálogo. Si falta, se usa el del botón. */
  titulo?: string;
  /** Una línea bajo el título: para qué es esto. */
  descripcion?: string;
  campos: CampoDialogo[];
  chat: LoQueRecogeElChat;
  /** La plantilla aprobada por Meta con la que se abre la conversación. */
  plantilla: {
    nombre: string;
    idioma?: string;
    /** `utility` por omisión. Ver `textoParaMeta` para por qué importa. */
    categoria?: "utility" | "marketing" | "authentication";
    /**
     * El cuerpo tal como se somete a Meta, con sus huecos `{{1}}`, `{{2}}`…
     *
     * Es opcional para no romper a quien ya tenga una plantilla aprobada por
     * fuera, pero conviene declararlo: sin él nadie puede comprobar que los
     * huecos coincidan con las variables de abajo, y ese desajuste **aparece
     * en producción al invitar** —Meta rechaza el envío, el caso queda creado
     * y la persona nunca recibe nada—. Con el cuerpo aquí, `validarPlantilla`
     * lo caza en una prueba.
     */
    cuerpo?: string;
    /**
     * Qué va en los `{{1}}`, `{{2}}`… del cuerpo aprobado, en orden, nombrando
     * la clave del campo del que sale cada uno.
     *
     * Meta **rechaza una variable vacía**, así que un campo opcional necesita
     * un valor por omisión. Es la clase de detalle que solo se descubre cuando
     * la plantilla ya está aprobada y el mensaje no sale.
     */
    variables: { campo: string; siVacio?: string }[];
  };
};

/** Un caso abierto: lo que se creó al invitar. */
export type Caso = {
  id: string;
  formulario: string;
  telefono: string;
  /** Los valores del diálogo, por clave de campo. */
  valores: Record<string, string | null>;
  estado: "invitado" | "en_curso" | "cerrado";
};

/**
 * Dónde se guarda. Lo implementa quien instala la librería.
 *
 * `registrarMensaje` **devuelve `false` si ese `wamid` ya estaba**, y esa es la
 * pieza que impide duplicados: Meta reintenta la entrega de un webhook que no
 * responda a tiempo, y sin una clave única por mensaje una foto se guarda dos
 * o tres veces. La unicidad tiene que vivir en la base, no en memoria: dos
 * instancias del servidor reciben reintentos distintos.
 */
export type Repositorio = {
  crearCaso(entrada: {
    formulario: string;
    telefono: string;
    valores: Record<string, string | null>;
  }): Promise<Caso>;

  /** El caso ABIERTO de ese teléfono, o null. Solo puede haber uno. */
  casoAbiertoDe(telefono: string): Promise<Caso | null>;

  /** `false` si el `wamid` ya existía: es un reintento y no hay que hacer nada. */
  registrarMensaje(m: {
    casoId: string | null;
    wamid: string;
    direccion: "entrante" | "saliente";
    tipo: "texto" | "imagen" | "plantilla" | "otro";
    texto: string | null;
    ocurridoEn: string | null;
  }): Promise<boolean>;

  guardarInforme(casoId: string, texto: string): Promise<void>;

  guardarFoto(casoId: string, foto: { ruta: string; contentType: string; bytes: number; sha256: string }): Promise<void>;

  /** Cuántas fotos e informes lleva el caso. Para saber si ya se puede cerrar. */
  contar(casoId: string): Promise<{ informes: number; fotos: number }>;

  cerrarCaso(casoId: string): Promise<void>;

  /** Qué pasó al intentar mandar la invitación. Un fallo no se pierde. */
  anotarEnvio(casoId: string, r: { ok: boolean; wamid?: string; error?: string }): Promise<void>;
};

/**
 * Dónde van los archivos. Lo implementa quien instala.
 *
 * Quien lo implemente debería **releer el objeto y comparar** antes de dar la
 * subida por buena. Suena a exceso y no lo es: en el proyecto donde nació esta
 * librería se perdieron 88 fotografías de 23 reportes porque el archivo se
 * daba por subido sin releerlo, todo respondía 200, y el daño solo apareció
 * semanas después cuando algo intentó abrir una imagen.
 */
export type Almacen = {
  guardar(entrada: {
    bytes: Uint8Array;
    contentType: string;
    /** Carpeta sugerida, derivada de la clave del formulario. */
    prefijo: string;
  }): Promise<{ ruta: string; sha256: string; bytes: number }>;
};

type SpeechRec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }>;
};

type SpeechCtor = new () => SpeechRec;

function getCtor(): SpeechCtor | null {
  const w = window as Window & {
    SpeechRecognition?: SpeechCtor;
    webkitSpeechRecognition?: SpeechCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechSupported(): boolean {
  return typeof window !== "undefined" && Boolean(getCtor());
}

/** Non-destructive dictation: inserts final transcripts via onInsert. */
export function createDictation(opts: {
  onInsert: (text: string) => void;
  onActiveChange?: (active: boolean) => void;
  onError?: (msg: string) => void;
  lang?: string;
}) {
  let rec: SpeechRec | null = null;
  let active = false;
  let wantActive = false;

  const setActive = (v: boolean) => {
    active = v;
    opts.onActiveChange?.(v);
  };

  const start = () => {
    const Ctor = getCtor();
    if (!Ctor) {
      opts.onError?.("Speech recognition not available in this browser");
      return;
    }
    wantActive = true;
    if (rec) {
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
      rec = null;
    }
    const r = new Ctor();
    r.lang = opts.lang ?? "en-US";
    r.continuous = true;
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.onresult = (ev) => {
      let chunk = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal === false) continue;
        const t = res[0]?.transcript?.trim();
        if (t) chunk += (chunk ? " " : "") + t;
      }
      if (chunk) opts.onInsert(chunk);
    };
    r.onerror = (ev) => {
      const err = ev.error ?? "speech_error";
      if (err !== "aborted" && err !== "no-speech") {
        opts.onError?.(err);
      }
      setActive(false);
    };
    r.onend = () => {
      setActive(false);
      // Auto-restart if user still wants mic on (Safari ends often).
      if (wantActive) {
        try {
          r.start();
          setActive(true);
        } catch {
          wantActive = false;
        }
      }
    };
    rec = r;
    try {
      r.start();
      setActive(true);
    } catch (e) {
      wantActive = false;
      setActive(false);
      opts.onError?.(e instanceof Error ? e.message : "mic_start_failed");
    }
  };

  const stop = () => {
    wantActive = false;
    if (!rec) {
      setActive(false);
      return;
    }
    try {
      rec.stop();
    } catch {
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    }
    setActive(false);
  };

  const toggle = () => {
    if (active || wantActive) stop();
    else start();
  };

  return {
    start,
    stop,
    toggle,
    isActive: () => active,
    supported: () => Boolean(getCtor()),
  };
}

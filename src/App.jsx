import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useRef, useState, useCallback } from "react";

// ===== Cookie helpers =====
const COOKIE_KEY = "sguess_state";
const COOKIE_DAYS = 2;

function setCookie(name, value, days) {
    const expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(JSON.stringify(value))}; expires=${expires}; path=/; SameSite=Lax`;
}

function getCookie(name) {
    const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    if (!match) return null;
    try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function deleteCookie(name) {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
}

// ===== Text normalisation =====
function normalize(str) {
    return str
        .toLowerCase()
        .replace(/\(feat\..*?\)/g, "")
        .replace(/\[.*?\]/g, "")
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function isCorrectGuess(guess, correctTitle, correctArtist) {
    const g = normalize(guess);
    const t = normalize(correctTitle);
    const a = normalize(correctArtist);
    return (g.includes(t) && g.includes(a)) || g === t;
}

// ===== Default game state =====
function defaultGuesses() {
    return Array(6).fill(null).map(() => ({ text: "", status: "empty" }));
}

const EMPTY_STATE = {
    guesses:    defaultGuesses(),
    stageIndex: 0,
    gameOver:   false,
    won:        false,
};

export default function App() {
    const BACKEND_URL = "https://api.niqbit.com";
    const stages      = [0.1, 0.5, 2, 5, 10, 20];
    const START_MS    = 1000;

    // ===== Refs =====
    const stageIndexRef    = useRef(0);
    const iframeRef        = useRef(null);
    const widgetRef        = useRef(null);
    const suppressPauseRef = useRef(false);
    const reachedEndRef    = useRef(false);
    const debounceRef      = useRef(null);
    const songUrlRef       = useRef(null);

    // ===== State =====
    const [songUrl,         setSongUrl]         = useState(null);
    const [isPlaying,       setIsPlaying]       = useState(false);
    const [progress,        setProgress]        = useState(0);
    const [stageIndex,      setStageIndex]      = useState(0);
    const [correctTitle,    setCorrectTitle]    = useState("");
    const [correctArtist,   setCorrectArtist]   = useState("");
    const [inputValue,      setInputValue]      = useState("");
    const [suggestions,     setSuggestions]     = useState([]);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [isSearching,     setIsSearching]     = useState(false);
    const [guesses,         setGuesses]         = useState(defaultGuesses());
    const [gameOver,        setGameOver]        = useState(false);
    const [won,             setWon]             = useState(false);
    const [loadError,       setLoadError]       = useState(null);

    useEffect(() => { stageIndexRef.current = stageIndex; }, [stageIndex]);

    // ===== Helpers =====
    const getStageDuration = () => stages[stageIndexRef.current] * 1000;
    const getWidthPct      = (index = stageIndexRef.current) => (stages[index] / 20) * 100;
    const currentGuessIndex = guesses.findIndex(g => g.status === "empty");

    // ===== Persist game state to cookie whenever it changes =====
    const persistState = useCallback((overrides = {}) => {
        if (!songUrlRef.current) return;
        setCookie(COOKIE_KEY, {
            songUrl:    songUrlRef.current,
            guesses,
            stageIndex: stageIndexRef.current,
            gameOver,
            won,
            ...overrides,
        }, COOKIE_DAYS);
    }, [guesses, gameOver, won]);

    useEffect(() => { persistState(); }, [guesses, gameOver, won]);

    // ===== Fetch daily song =====
    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${BACKEND_URL}/sguess/daily`);
                if (!res.ok) throw new Error(`Server returned ${res.status}`);
                const data = await res.json();
                const dailyUrl = data.url;
                if (!dailyUrl) throw new Error("No url in response");

                const saved = getCookie(COOKIE_KEY);

                if (saved && saved.songUrl === dailyUrl) {
                    songUrlRef.current = dailyUrl;
                    setSongUrl(dailyUrl);
                    setGuesses(saved.guesses    ?? defaultGuesses());
                    setStageIndex(saved.stageIndex ?? 0);
                    stageIndexRef.current = saved.stageIndex ?? 0;
                    setGameOver(saved.gameOver ?? false);
                    setWon(saved.won         ?? false);
                } else {
                    songUrlRef.current = dailyUrl;
                    setSongUrl(dailyUrl);
                    deleteCookie(COOKIE_KEY);
                    setGuesses(defaultGuesses());
                    setStageIndex(0);
                    stageIndexRef.current = 0;
                    setGameOver(false);
                    setWon(false);
                    setCookie(COOKIE_KEY, {
                        songUrl:    dailyUrl,
                        guesses:    defaultGuesses(),
                        stageIndex: 0,
                        gameOver:   false,
                        won:        false,
                    }, COOKIE_DAYS);
                }
            } catch (err) {
                console.error("Failed to fetch daily song:", err);
                setLoadError("Could not load today's song. Please try again later.");
            }
        })();
    }, []);

    // ===== SoundCloud widget =====
    useEffect(() => {
        if (!songUrl) return;

        if (widgetRef.current) {
            try { widgetRef.current.unbind(window.SC?.Widget?.Events?.PLAY_PROGRESS); } catch {}
            widgetRef.current = null;
        }

        const initWidget = () => {
            if (!window.SC || !iframeRef.current) return;
            const widget = window.SC.Widget(iframeRef.current);
            widgetRef.current = widget;

            widget.bind(window.SC.Widget.Events.READY, () => {
                widget.getCurrentSound((sound) => {
                    if (sound) {
                        setCorrectTitle(sound.title || "");
                        setCorrectArtist(sound.user?.username || "");
                    }
                });
            });
            widget.bind(window.SC.Widget.Events.PLAY, () => setIsPlaying(true));
            widget.bind(window.SC.Widget.Events.PAUSE, () => {
                if (suppressPauseRef.current) { suppressPauseRef.current = false; return; }
                setIsPlaying(false);
            });
            widget.bind(window.SC.Widget.Events.PLAY_PROGRESS, (event) => {
                const current  = event.currentPosition;
                const elapsed  = current - START_MS;
                const duration = getStageDuration();
                if (elapsed >= 0) setProgress(Math.min(elapsed / duration, 1) * 100);
                if (current >= START_MS + duration) {
                    reachedEndRef.current    = true;
                    suppressPauseRef.current = true;
                    widget.pause();
                    setIsPlaying(false);
                    setProgress(100);
                }
            });
        };

        if (window.SC) {
            initWidget();
        } else {
            const existing = document.querySelector('script[src="https://w.soundcloud.com/player/api.js"]');
            if (existing) {
                existing.addEventListener("load", initWidget);
                return () => existing.removeEventListener("load", initWidget);
            }
            const script = document.createElement("script");
            script.src = "https://w.soundcloud.com/player/api.js";
            script.onload = initWidget;
            document.body.appendChild(script);
            return () => { try { document.body.removeChild(script); } catch {} };
        }
    }, [songUrl]); // eslint-disable-line react-hooks/exhaustive-deps

    // ===== Search =====
    const searchSongs = useCallback(async (query) => {
        if (!query || query.length < 2) { setSuggestions([]); return; }
        setIsSearching(true);
        try {
            const res = await fetch(`${BACKEND_URL}/sguess/search`, {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ query }),
            });
            if (!res.ok) throw new Error("Search failed");
            const results = await res.json();
            setSuggestions(results);
            setShowSuggestions(true);
        } catch {
            setSuggestions([]);
        } finally {
            setIsSearching(false);
        }
    }, []);

    const handleInputChange = (e) => {
        const val = e.target.value;
        setInputValue(val);
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => searchSongs(val), 400);
    };

    // ===== Guess logic =====
    const submitGuess = useCallback((guessText) => {
        if (gameOver || currentGuessIndex === -1) return;
        const correct     = isCorrectGuess(guessText, correctTitle, correctArtist);
        const newGuesses  = [...guesses];
        newGuesses[currentGuessIndex] = { text: guessText, status: correct ? "correct" : "wrong" };

        let newGameOver = false, newWon = false;
        if (correct) {
            newGameOver = true; newWon = true;
        } else if (currentGuessIndex === 5) {
            newGameOver = true;
        }

        const nextStageIndex = (!correct && currentGuessIndex < 5)
            ? Math.min(stageIndexRef.current + 1, stages.length - 1)
            : stageIndexRef.current;

        stageIndexRef.current = nextStageIndex;
        setStageIndex(nextStageIndex);
        setGuesses(newGuesses);
        setInputValue("");
        setSuggestions([]);
        setShowSuggestions(false);
        if (newGameOver) { setGameOver(true); if (newWon) setWon(true); }

        setCookie(COOKIE_KEY, {
            songUrl:    songUrlRef.current,
            guesses:    newGuesses,
            stageIndex: nextStageIndex,
            gameOver:   newGameOver,
            won:        newWon,
        }, COOKIE_DAYS);
    }, [gameOver, currentGuessIndex, correctTitle, correctArtist, guesses, stages.length]);

    const skipGuess = useCallback(() => {
        if (gameOver || currentGuessIndex === -1) return;
        const newGuesses = [...guesses];
        newGuesses[currentGuessIndex] = { text: "Skipped", status: "skipped" };

        let newGameOver = false;
        if (currentGuessIndex === 5) newGameOver = true;

        const nextStageIndex = (!newGameOver)
            ? Math.min(stageIndexRef.current + 1, stages.length - 1)
            : stageIndexRef.current;

        stageIndexRef.current = nextStageIndex;
        setStageIndex(nextStageIndex);
        setGuesses(newGuesses);
        setInputValue("");
        setSuggestions([]);
        if (newGameOver) setGameOver(true);

        setCookie(COOKIE_KEY, {
            songUrl:    songUrlRef.current,
            guesses:    newGuesses,
            stageIndex: nextStageIndex,
            gameOver:   newGameOver,
            won:        false,
        }, COOKIE_DAYS);
    }, [gameOver, currentGuessIndex, guesses, stages.length]);

    const handleSuggestionClick = (suggestion) => {
        setInputValue(suggestion.label);
        setShowSuggestions(false);
        submitGuess(suggestion.label);
    };

    const handleKeyDown = (e) => {
        if (e.key === "Enter" && inputValue.trim()) submitGuess(inputValue.trim());
        else if (e.key === "Escape") setShowSuggestions(false);
    };

    // ===== Playback =====
    const togglePlayback = () => {
        const widget = widgetRef.current;
        if (!widget) return;
        if (isPlaying) {
            suppressPauseRef.current = true;
            widget.pause();
            setIsPlaying(false);
            setProgress(0);
            reachedEndRef.current = false;
        } else {
            setProgress(0);
            reachedEndRef.current    = false;
            suppressPauseRef.current = true;
            widget.seekTo(START_MS);
            widget.play();
        }
    };

    // ===== UI helpers =====
    const guessRowColor = (status) => {
        if (status === "correct") return "bg-defgreen text-black";
        if (status === "wrong")   return "bg-defred text-black";
        if (status === "skipped") return "bg-panel text-white/40 italic";
        return "bg-panel text-white/20";
    };

    const currentStage = stages[stageIndex];

    // ===== Render =====
    return (
        <div className="fixed h-full w-full bg-background flex justify-center items-center">
            {/* SoundCloud iframe */}
            {songUrl && (
                <iframe
                    ref={iframeRef}
                    key={songUrl}
                    width="0" height="0"
                    allow="autoplay"
                    className="hidden"
                    src={`https://w.soundcloud.com/player/?url=${encodeURIComponent(songUrl)}`}
                />
            )}

            <div className="relative h-4/5 w-2/5 bg-highlight border-border border-[0.5px] rounded-2xl flex justify-end items-center gap-5 flex-col p-10">

                {/* Loading / error state */}
                {!songUrl && !loadError && (
                    <div className="text-white/40 font-mono text-sm">Loading today's song…</div>
                )}
                {loadError && (
                    <div className="text-defred font-mono text-sm text-center">{loadError}</div>
                )}

                {songUrl && (
                    <>
                        {/* Guesses */}
                        <div className="h-1/2 w-5/6 flex justify-center items-center flex-col gap-2">
                            {guesses.map((guess, i) => (
                                <div
                                    key={i}
                                    className={`w-full h-1/7 border-border border-[0.5px] font-mono text-xl flex justify-center items-center text-center rounded-lg px-3 transition-colors duration-300 ${guessRowColor(guess.status)}`}
                                >
                                    {guess.status === "empty" ? "" : guess.status === "skipped" ? "Skipped" : guess.text}
                                </div>
                            ))}
                        </div>

                        {/* Game over banner */}
                        {gameOver && (
                            <div className={`w-5/6 rounded-lg border-border border-[0.5px] py-3 px-4 text-center font-mono text-lg ${won ? "bg-defgreen text-black" : "bg-defred text-black"}`}>
                                {won ? "🎉 Correct!" : `The song was: ${correctArtist} - ${correctTitle}`}
                            </div>
                        )}

                        {/* Guessing field */}
                        {!gameOver && (
                            <div className="relative w-5/6">
                                <div className="w-full h-15 rounded-lg bg-panel border-border border-[0.5px] flex items-center">
                                    <input
                                        type="text"
                                        value={inputValue}
                                        onChange={handleInputChange}
                                        onKeyDown={handleKeyDown}
                                        onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                                        placeholder="Guess a song..."
                                        className="text-white font-mono text-base w-full h-full p-5 bg-transparent outline-none"
                                    />
                                    {isSearching && <span className="text-white/40 font-mono text-xs pr-3">...</span>}
                                </div>

                                <AnimatePresence>
                                    {showSuggestions && suggestions.length > 0 && (
                                        <motion.div
                                            initial={{ opacity: 0, y: -4 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            exit={{ opacity: 0, y: -4 }}
                                            transition={{ duration: 0.12 }}
                                            className="absolute bottom-full mb-1 w-full bg-panel border-border border-[0.5px] rounded-lg overflow-hidden z-50"
                                        >
                                            {suggestions.map((s, i) => (
                                                <div
                                                    key={i}
                                                    onClick={() => handleSuggestionClick(s)}
                                                    className="px-4 py-2 text-white font-mono text-sm cursor-pointer hover:bg-highlight border-b border-border/30 last:border-0 flex items-center justify-between gap-2"
                                                >
                                                    <span className="truncate">{s.label}</span>
                                                    <span className="shrink-0 text-xs text-white/40 tabular-nums" title={`Popularity: ${s.popularity}/100`}>
                                                        {s.popularity}
                                                    </span>
                                                </div>
                                            ))}
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>
                        )}

                        {/* Progress bar */}
                        <div className="relative w-5/6 h-12 bg-panel border-border border-[0.5px] rounded-lg overflow-hidden text-white font-mono">
                            <div className="absolute top-0 w-full h-full flex justify-center items-center text-3xl z-10 mix-blend-difference">
                                {currentStage.toFixed(1)}s
                            </div>
                            <div className="absolute h-full bg-content rounded-lg" style={{ width: `${getWidthPct(stageIndex)}%` }}>
                                <div className="bg-gray-200 h-full rounded-lg transition-all duration-75" style={{ width: `${progress}%` }} />
                            </div>
                        </div>

                        {/* Media Controls */}
                        <div className="relative w-2/5 h-25 flex justify-center items-center gap-2">
                            <motion.div className="relative h-1/2 aspect-square bg-white rounded-full" whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} />

                            <motion.div
                                onClick={togglePlayback}
                                className="relative bg-defgreen rounded-full h-full aspect-square border-border border-[0.5px] p-3 cursor-pointer flex justify-center items-center"
                                whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                                transition={{ type: "spring", stiffness: 500, damping: 30 }}
                            >
                                <span className="text-white font-bold text-xl p-5">
                                    {isPlaying ? <img src="/pause.svg" alt="pause" /> : <img src="/play.svg" alt="play" />}
                                </span>
                            </motion.div>

                            <motion.div
                                onClick={skipGuess}
                                className="relative h-1/2 aspect-square bg-white rounded-full cursor-pointer flex justify-center items-center p-2"
                                whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                            >
                                <img src="/skip.svg" alt="skip" />
                            </motion.div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
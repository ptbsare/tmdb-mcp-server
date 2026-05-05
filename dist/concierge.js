const MOODS = {
    crowd: {
        label: "Crowd pleaser",
        genres: [28, 12, 35],
        keywords: ["friendship", "family", "adventure"],
        sortBy: "popularity.desc",
    },
    thriller: {
        label: "Tense thriller",
        genres: [53, 80, 9648],
        keywords: ["murder", "conspiracy", "investigation"],
        sortBy: "vote_average.desc",
    },
    thoughtful: {
        label: "Thoughtful drama",
        genres: [18, 36],
        keywords: ["coming of age", "relationship", "biography"],
        sortBy: "vote_average.desc",
    },
    funny: {
        label: "Light comedy",
        genres: [35, 10749],
        keywords: ["romantic comedy", "satire", "road trip"],
        sortBy: "popularity.desc",
    },
    family: {
        label: "Family night",
        genres: [16, 10751, 12],
        keywords: ["magic", "animals", "school"],
        sortBy: "popularity.desc",
    },
    mindbend: {
        label: "Mind-bending sci-fi",
        genres: [878, 9648, 53],
        keywords: ["time travel", "artificial intelligence", "alternate reality"],
        sortBy: "vote_average.desc",
    },
};
const LANGUAGE_LABELS = {
    any: "Any language",
    en: "English",
    hi: "Hindi",
    ta: "Tamil",
    te: "Telugu",
    ml: "Malayalam",
    kn: "Kannada",
    ko: "Korean",
    ja: "Japanese",
    fr: "French",
    es: "Spanish",
};
const COUNTRY_DEFAULT = "IN";
function normalizeCountry(country) {
    return (country || COUNTRY_DEFAULT).trim().slice(0, 2).toUpperCase() || COUNTRY_DEFAULT;
}
function normalizeLanguage(language) {
    return (language || "any").trim().toLowerCase() || "any";
}
function normalizeMood(mood) {
    return MOODS[mood || "crowd"] ? mood || "crowd" : "crowd";
}
function yearFrom(date) {
    return date?.split("-")[0] || "unknown";
}
function posterUrl(path) {
    return path ? `https://image.tmdb.org/t/p/w500${path}` : undefined;
}
function providerNames(providers) {
    return providers?.map((provider) => provider.provider_name).filter(Boolean) || [];
}
function serviceMatchScore(available, requested) {
    if (requested.length === 0)
        return 0;
    const normalized = available.map((name) => name.toLowerCase());
    return requested.filter((service) => normalized.some((provider) => provider.includes(service.toLowerCase()))).length;
}
function parseRuntime(runtime) {
    if (!runtime || runtime === "any")
        return undefined;
    const parsed = Number(runtime);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function parseMinRating(minRating) {
    const parsed = Number(minRating || "6.5");
    if (!Number.isFinite(parsed))
        return 6.5;
    return Math.min(9, Math.max(0, parsed));
}
async function fetchFromTMDB(env, endpoint, params = {}) {
    if (!env.TMDB_API_KEY) {
        throw new Error("TMDB_API_KEY is not configured.");
    }
    const baseUrl = env.TMDB_BASE_URL || "https://api.themoviedb.org/3";
    const url = new URL(`${baseUrl}${endpoint}`);
    url.searchParams.set("api_key", env.TMDB_API_KEY);
    for (const [key, value] of Object.entries(params)) {
        if (value !== "")
            url.searchParams.set(key, value);
    }
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`TMDB API error: ${response.status} ${response.statusText}`);
            }
            return response.json();
        }
        catch (error) {
            lastError = error;
            if (attempt < 2) {
                await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
            }
        }
    }
    throw lastError instanceof Error ? lastError : new Error("TMDB request failed.");
}
async function keywordIdsFor(env, keywords) {
    const ids = [];
    for (const keyword of keywords.slice(0, 2)) {
        try {
            const data = await fetchFromTMDB(env, "/search/keyword", { query: keyword });
            if (data.results[0]?.id)
                ids.push(String(data.results[0].id));
        }
        catch {
            // Keyword discovery is only a ranking assist; base discovery can still work without it.
        }
    }
    return ids;
}
async function settledList(label, promise) {
    try {
        const data = await promise;
        return { label, results: data.results, ok: true };
    }
    catch {
        return { label, results: [], ok: false };
    }
}
function uniqueMovies(groups) {
    const seen = new Set();
    const merged = [];
    for (const group of groups) {
        for (const movie of group) {
            if (!seen.has(movie.id)) {
                seen.add(movie.id);
                merged.push(movie);
            }
        }
    }
    return merged;
}
function scorePick(movie, countryProviders, profile, requestedServices) {
    const streaming = providerNames(countryProviders?.flatrate);
    const rent = providerNames(countryProviders?.rent);
    const buy = providerNames(countryProviders?.buy);
    const allProviders = [...streaming, ...rent, ...buy];
    const serviceMatches = serviceMatchScore(allProviders, requestedServices);
    const movieGenreIds = movie.genres?.map((genre) => genre.id) || movie.genre_ids || [];
    const genreMatches = movieGenreIds.filter((id) => profile.genres.includes(id)).length;
    const recentYear = Number(yearFrom(movie.release_date));
    const recentBoost = Number.isFinite(recentYear) ? Math.max(0, recentYear - 2015) / 3 : 0;
    let score = movie.vote_average * 11;
    score += Math.min(movie.vote_count || 0, 3000) / 150;
    score += Math.min(movie.popularity || 0, 120) / 5;
    score += genreMatches * 8;
    score += streaming.length > 0 ? 8 : 0;
    score += serviceMatches * 18;
    score += recentBoost;
    const reasons = [];
    if (genreMatches > 0)
        reasons.push(`Fits ${profile.label.toLowerCase()} mode`);
    if (serviceMatches > 0)
        reasons.push(`Matches ${serviceMatches} requested service${serviceMatches > 1 ? "s" : ""}`);
    if (movie.vote_average >= 7.5)
        reasons.push(`Strong TMDB rating at ${movie.vote_average.toFixed(1)}/10`);
    if (streaming.length > 0)
        reasons.push(`Streaming in your selected country`);
    if (movie.runtime && movie.runtime <= 120)
        reasons.push(`Weekend-friendly ${movie.runtime} minute runtime`);
    if (reasons.length === 0)
        reasons.push("Balanced pick from TMDB popularity and ratings");
    return { score: Math.round(score), reasons: reasons.slice(0, 3) };
}
function pickFromDetails(movie, country, profile, requestedServices) {
    const countryProviders = movie["watch/providers"]?.results?.[country];
    const scored = scorePick(movie, countryProviders, profile, requestedServices);
    const director = movie.credits?.crew?.find((person) => person.job === "Director")?.name;
    return {
        id: movie.id,
        title: movie.title,
        year: yearFrom(movie.release_date),
        rating: movie.vote_average,
        runtime: movie.runtime,
        overview: movie.overview,
        posterUrl: posterUrl(movie.poster_path),
        genres: movie.genres?.map((genre) => genre.name) || [],
        director,
        cast: movie.credits?.cast?.slice(0, 4).map((person) => person.name) || [],
        providers: {
            streaming: providerNames(countryProviders?.flatrate),
            rent: providerNames(countryProviders?.rent),
            buy: providerNames(countryProviders?.buy),
            link: countryProviders?.link,
        },
        reasons: scored.reasons,
        score: scored.score,
    };
}
export async function createWeekendConcierge(env, rawInput) {
    const country = normalizeCountry(rawInput.country);
    const language = normalizeLanguage(rawInput.language);
    const mood = normalizeMood(rawInput.mood);
    const profile = MOODS[mood];
    const maxRuntime = parseRuntime(rawInput.runtime);
    const minRating = parseMinRating(rawInput.minRating);
    const requestedServices = (rawInput.services || []).map((service) => service.trim()).filter(Boolean);
    const keywordIds = await keywordIdsFor(env, profile.keywords);
    const discoverParams = {
        include_adult: "false",
        sort_by: profile.sortBy,
        "vote_count.gte": "120",
        "vote_average.gte": String(minRating),
        with_genres: profile.genres.join("|"),
        watch_region: country,
    };
    if (language !== "any")
        discoverParams.with_original_language = language;
    if (maxRuntime)
        discoverParams["with_runtime.lte"] = String(maxRuntime);
    const keywordParams = { ...discoverParams };
    if (keywordIds.length > 0)
        keywordParams.with_keywords = keywordIds.join("|");
    const sources = await Promise.all([
        settledList("discover", fetchFromTMDB(env, "/discover/movie", discoverParams)),
        settledList("keyword discover", fetchFromTMDB(env, "/discover/movie", keywordParams)),
        settledList("trending", fetchFromTMDB(env, "/trending/movie/week")),
        settledList("now playing", fetchFromTMDB(env, "/movie/now_playing", { region: country })),
    ]);
    const failedSources = sources.filter((source) => !source.ok).map((source) => source.label);
    const [discover, keywordDiscover, trending, nowPlaying] = sources;
    const candidates = uniqueMovies([
        keywordDiscover.results.slice(0, 8),
        discover.results.slice(0, 10),
        trending.results.slice(0, 8),
        nowPlaying.results.slice(0, 6),
    ]).slice(0, 18);
    const detailedResults = await Promise.allSettled(candidates.map((movie) => fetchFromTMDB(env, `/movie/${movie.id}`, {
        append_to_response: "credits,watch/providers",
    })));
    const detailed = detailedResults
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value);
    const picks = detailed
        .map((movie) => pickFromDetails(movie, country, profile, requestedServices))
        .filter((pick) => !maxRuntime || !pick.runtime || pick.runtime <= maxRuntime)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
    const notes = [
        requestedServices.length > 0
            ? "Service matches are boosted when TMDB has provider data for the selected country."
            : "Add streaming services to bias the ranking toward titles you can watch tonight.",
    ];
    if (picks.every((pick) => pick.providers.streaming.length === 0)) {
        notes.push("TMDB did not return subscription streaming providers for these picks in the selected country.");
    }
    if (failedSources.length > 0) {
        notes.push(`Some TMDB sources were unavailable during this run: ${failedSources.join(", ")}.`);
    }
    if (detailed.length < candidates.length) {
        notes.push("Some candidate details were skipped because TMDB detail requests failed.");
    }
    return {
        generatedAt: new Date().toISOString(),
        country,
        language: LANGUAGE_LABELS[language] || language,
        mood: profile.label,
        picks,
        notes,
    };
}

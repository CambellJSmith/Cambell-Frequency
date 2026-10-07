"use strict";

let player = null; // Holds the official YouTube iframe player.
let manifest = null; // Holds the small archive index used to discover schedule publications.
let loaded_publications = new Map(); // Caches immutable schedule publications by path.
let active_track = null; // Tracks the item currently expected on air.
let joined_live = false; // Records whether the listener has opted into playback.
let player_ready = false; // Records whether the YouTube API player is ready.
let muted = false; // Stores the mute state controlled by the station UI.
let refresh_timer = 0; // Stores the archive refresh timer identifier.
let sync_timer = 0; // Stores the playback synchronization timer identifier.
let announcer_timer = 0; // Stores the high-frequency announcer timing loop.
let active_announcement_key = ""; // Identifies the currently playing archived announcer clip.
let ducked_volume = null; // Remembers the listener's music volume while an announcer clip is speaking.
let volume_fade_generation = 0; // Cancels stale asynchronous volume envelopes when mute or speech state changes.
const played_announcements = new Set(); // Prevents the same archived clip from replaying during one page session.

const manifest_url = "data/index.json"; // Points to the append-only schedule archive index.
const legacy_schedule_url = "data/station.json"; // Provides compatibility with older single-file bundles.
const refresh_interval_ms = 30000; // Controls how often the browser checks GitHub Pages for schedule publications.
const sync_interval_ms = 5000; // Controls how often playback drift is checked.
const drift_tolerance_seconds = 2.5; // Defines how much playback drift is tolerated before correction.
const schedule_window_ms = 72 * 60 * 60 * 1000; // Defines the rolling three-day schedule visible to listeners and publication discovery.
const announcer_poll_interval_ms = 500; // Checks short announcer windows accurately without affecting schedule refresh frequency.
const announcer_duck_volume = 18; // Reduces music beneath speech while preserving a radio-style bed.
const announcer_fade_down_ms = 650; // Gives presenter links a short broadcast-style music fade before speech begins.
const announcer_fade_up_ms = 900; // Returns the music slightly more gently after the presenter finishes.
const volume_fade_step_ms = 50; // Limits iframe volume commands to twenty updates per second for smooth low-overhead fades.
const announcer_audio = new Audio(); // Reuses one audio element for every immutable Piper announcement.

const station_name = document.getElementById("station_name"); // Displays the configured station name.
const live_badge = document.getElementById("live_badge"); // Displays whether a track is currently scheduled.
const track_title = document.getElementById("track_title"); // Displays the current track title.
const track_meta = document.getElementById("track_meta"); // Displays the current track artist.
const up_next = document.getElementById("up_next"); // Contains the upcoming schedule rows.
const status = document.getElementById("status"); // Displays station and synchronization messages.
const join_button = document.getElementById("join_button"); // Starts listener playback after browser interaction.
const mute_button = document.getElementById("mute_button"); // Controls player muting through the station UI.
const progress_fill = document.getElementById("progress_fill"); // Displays progress through the current scheduled item.
const elapsed = document.getElementById("elapsed"); // Displays elapsed playback time.
const remaining = document.getElementById("remaining"); // Displays remaining playback time.

window.onYouTubeIframeAPIReady = function() { // Creates the supported YouTube player when its API is available.
    player = new YT.Player("player", { // Instantiates the official embedded player.
        width: "100%", // Lets CSS control the responsive player width.
        height: "100%", // Lets CSS control the responsive player height.
        playerVars: { playsinline: 1, controls: 1 }, // Keeps playback inside the page.
        events: { onReady: on_player_ready, onError: on_player_error, onAutoplayBlocked: on_autoplay_blocked } // Connects player lifecycle events.
    }); // Finishes player creation.
}; // Finishes the API-ready callback.

function on_player_ready() { // Marks playback controls as available.
    player_ready = true; // Allows synchronization to address the player.
    muted = typeof player.isMuted === "function" ? player.isMuted() : false; // Reads the player mute state when available.
    update_mute_button(); // Enables the custom mute control and reflects the current state.
    synchronize_playback(true); // Loads the live item if the listener already joined.
} // Finishes player-ready handling.

function update_mute_button() { // Keeps the custom mute control synchronized with player state.
    mute_button.disabled = !player_ready; // Prevents mute commands before the YouTube player is ready.
    mute_button.textContent = muted ? "Unmute" : "Mute"; // Shows the action that the button will perform.
    mute_button.setAttribute("aria-pressed", String(muted)); // Exposes the current mute state to assistive technology.
} // Finishes mute button rendering.

function toggle_mute() { // Toggles audio through the custom station control while preserving announcer ducking state.
    if (!player_ready) return; // Ignores input until the player can accept commands.
    cancel_volume_fade(); // Stops any in-progress fade before changing the listener's explicit mute state.
    if (muted) { // Restores audio when the station is currently muted.
        if (typeof player.unMute === "function") player.unMute(); // Requests unmuted playback from the YouTube player.
        muted = false; // Records the new station mute state.
        if (active_announcement_key && typeof player.setVolume === "function") { // Keeps music underneath speech if the listener unmutes mid-announcement.
            const current_volume = Number(player.getVolume?.() ?? 100); // Reads the player's current level after unmuting.
            if (ducked_volume === null) ducked_volume = current_volume; // Preserves a restoration target when speech began while muted.
            player.setVolume(Math.min(current_volume, announcer_duck_volume)); // Applies the speech bed immediately rather than briefly blasting full music.
        } // Finishes mid-announcement unmute handling.
    } else { // Silences audio when the station is currently unmuted.
        if (typeof player.mute === "function") player.mute(); // Requests muted playback from the YouTube player.
        muted = true; // Records the new station mute state.
    } // Finishes mute state switching.
    announcer_audio.muted = muted; // Keeps locally hosted announcer speech aligned with the station mute state.
    update_mute_button(); // Refreshes the visible control after the change.
} // Finishes custom mute handling.

function on_player_error(event) { // Reports YouTube playback failures without stopping schedule updates.
    set_status(`YouTube player error: ${event.data}. This video may not allow embedding.`, true); // Explains the likely playback issue.
} // Finishes player error handling.

function on_autoplay_blocked() { // Handles browsers that require another explicit playback gesture.
    joined_live = false; // Returns the station to a user-controlled start state.
    join_button.disabled = false; // Allows another playback attempt.
    join_button.textContent = "Join Live"; // Restores the action label.
    set_status("Playback was blocked by the browser. Press Join Live to start.", false); // Gives the listener a recovery action.
} // Finishes autoplay-blocked handling.

async function load_station_data() { // Refreshes the manifest and only the schedule files relevant to now and the next broadcasts.
    try { // Keeps transient network failures from interrupting an already-running station.
        const incoming_manifest = await fetch_manifest(); // Retrieves the newest archive index with cache bypassing.
        validate_manifest(incoming_manifest); // Rejects malformed archive metadata before using it.
        manifest = incoming_manifest; // Replaces the active archive index atomically.
        station_name.textContent = manifest.station_name || "Cambell Frequency"; // Applies the fixed station title.
        await load_relevant_publications(Date.now()); // Fetches active and nearest-future immutable publications only.
        render_station(); // Updates now-playing and upcoming information from the merged archive view.
        synchronize_playback(false); // Applies newly published schedule changes to an active listener.
        set_status(`Schedule archive updated · ${manifest.publications.length} publication${manifest.publications.length === 1 ? "" : "s"}.`, false); // Reports archive freshness without exposing implementation detail.
    } catch (error) { // Handles unavailable or malformed archive data.
        const recovered = await try_load_legacy_schedule(error); // Falls back to the old single-file format when available.
        if (!recovered) set_status(`Could not load station schedule: ${error.message}`, true); // Leaves current playback running while reporting the failure.
    } // Finishes archive refresh error handling.
} // Finishes station data refresh.

async function fetch_manifest() { // Retrieves the archive index without accepting stale browser caches.
    const response = await fetch(`${manifest_url}?v=${Date.now()}`, { cache: "no-store" }); // Requests the newest committed index from GitHub Pages.
    if (!response.ok) throw new Error(`archive index HTTP ${response.status}`); // Rejects missing or failed index responses.
    return response.json(); // Parses and returns the archive index.
} // Finishes archive-index retrieval.

function validate_manifest(candidate) { // Checks the schema needed to discover immutable schedule files.
    if (!candidate || !Array.isArray(candidate.publications)) throw new Error("archive index publications must be an array"); // Requires a publication catalog.
    const timezone = candidate.timezone || "UTC"; // Reads the station timezone used for wall-clock display.
    try { new Intl.DateTimeFormat("en-GB", { timeZone: timezone }).format(new Date()); } catch (_) { throw new Error("archive index timezone must be a valid IANA timezone"); } // Rejects invalid timezone names.
    for (const publication of candidate.publications) { // Validates every catalog entry before file discovery.
        if (typeof publication.path !== "string" || publication.path.length === 0) throw new Error("every archive publication needs a path"); // Requires a fetchable immutable schedule path.
        if (Number.isNaN(Date.parse(publication.published_at))) throw new Error("every archive publication needs published_at"); // Requires publication-time precedence metadata.
        if (Number.isNaN(Date.parse(publication.starts_at))) throw new Error("every archive publication needs starts_at"); // Requires a coverage start for efficient discovery.
        if (Number.isNaN(Date.parse(publication.ends_at))) throw new Error("every archive publication needs ends_at"); // Requires a coverage end for efficient discovery.
    } // Finishes publication metadata validation.
} // Finishes manifest validation.

async function load_relevant_publications(now_ms) { // Loads only publications that can affect the live state or nearest upcoming queue.
    if (!manifest) return; // Stops until archive metadata exists.
    const eligible = manifest.publications.filter(publication => Date.parse(publication.published_at) <= now_ms); // Ignores publications whose recorded publish time has not arrived yet.
    const horizon_ms = now_ms + schedule_window_ms; // Calculates the exclusive end of the listener-visible rolling schedule.
    const active = eligible.filter(publication => Date.parse(publication.starts_at) <= now_ms && Date.parse(publication.ends_at) > now_ms); // Finds every publication whose coverage can affect the current instant.
    const future = eligible.filter(publication => Date.parse(publication.ends_at) > now_ms && Date.parse(publication.starts_at) < horizon_ms && !active.includes(publication)).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at)); // Loads every publication that can affect the next rolling 72 hours, including safe-edit suppressions.
    const wanted = new Map([...active, ...future].map(publication => [publication.path, publication])); // Deduplicates publication paths while preserving relevant metadata.
    await Promise.all([...wanted.values()].map(load_publication)); // Loads immutable files in parallel for low refresh latency.
    const retained_paths = new Set(wanted.keys()); // Builds the set of publication files still needed by the live view.
    for (const path of loaded_publications.keys()) if (!retained_paths.has(path)) loaded_publications.delete(path); // Releases stale publication data so archive growth does not grow browser memory indefinitely.
} // Finishes relevant-publication loading.

async function load_publication(metadata) { // Fetches and validates one immutable schedule publication when it is not already cached.
    if (loaded_publications.has(metadata.path)) return; // Reuses immutable publication data without repeated network requests.
    const response = await fetch(`data/${metadata.path}?v=${encodeURIComponent(metadata.published_at)}`, { cache: "force-cache" }); // Uses the immutable publication timestamp as a stable cache key.
    if (!response.ok) throw new Error(`schedule file ${metadata.path} HTTP ${response.status}`); // Rejects missing archive files.
    const publication = await response.json(); // Parses the schedule publication.
    validate_publication(publication, metadata); // Verifies track and precedence data before caching it.
    loaded_publications.set(metadata.path, publication); // Caches the immutable publication by manifest path.
} // Finishes publication retrieval.

function validate_publication(publication, metadata) { // Checks an immutable publication before it participates in schedule resolution.
    if (!publication || !Array.isArray(publication.tracks)) throw new Error(`schedule file ${metadata.path} has no tracks array`); // Requires a track collection.
    if (Number.isNaN(Date.parse(publication.published_at || metadata.published_at))) throw new Error(`schedule file ${metadata.path} has invalid published_at`); // Requires deterministic overlap precedence.
    for (const track of publication.tracks) { // Validates every scheduled song.
        if (typeof track.youtube_id !== "string" || track.youtube_id.length === 0) throw new Error(`schedule file ${metadata.path} contains a track without youtube_id`); // Requires a playable YouTube identifier.
        if (!Number.isFinite(Number(track.duration_seconds)) || Number(track.duration_seconds) <= 0) throw new Error(`schedule file ${metadata.path} contains an invalid duration`); // Requires a positive duration.
        if (Number.isNaN(Date.parse(track.starts_at))) throw new Error(`schedule file ${metadata.path} contains an invalid starts_at`); // Requires an absolute start timestamp.
    } // Finishes per-track validation.
    if (publication.announcements !== undefined && !Array.isArray(publication.announcements)) throw new Error(`schedule file ${metadata.path} has an invalid announcements collection`); // Keeps schema-1 files compatible while validating schema-2 speech.
    for (const announcement of publication.announcements || []) { // Validates every archived Piper announcement.
        if (typeof announcement.id !== "string" || announcement.id.length === 0) throw new Error(`schedule file ${metadata.path} contains an announcement without id`); // Requires a stable replay key.
        if (typeof announcement.audio_path !== "string" || announcement.audio_path.length === 0) throw new Error(`schedule file ${metadata.path} contains an announcement without audio_path`); // Requires fetchable local speech audio.
        if (!Number.isFinite(Number(announcement.duration_seconds)) || Number(announcement.duration_seconds) <= 0) throw new Error(`schedule file ${metadata.path} contains an invalid announcement duration`); // Requires a positive speech interval.
        if (Number.isNaN(Date.parse(announcement.starts_at))) throw new Error(`schedule file ${metadata.path} contains an invalid announcement starts_at`); // Requires absolute speech timing.
    } // Finishes per-announcement validation.
    if (publication.suppressions !== undefined && !Array.isArray(publication.suppressions)) throw new Error(`schedule file ${metadata.path} has an invalid suppressions collection`); // Keeps older schemas compatible while validating append-only safe edits.
    for (const suppression of publication.suppressions || []) { // Validates every immutable suppression interval.
        if (Number.isNaN(Date.parse(suppression.starts_at)) || Number.isNaN(Date.parse(suppression.ends_at))) throw new Error(`schedule file ${metadata.path} contains an invalid suppression interval`); // Requires absolute edit boundaries.
        if (Date.parse(suppression.ends_at) <= Date.parse(suppression.starts_at)) throw new Error(`schedule file ${metadata.path} contains a reversed suppression interval`); // Requires a positive edit window.
    } // Finishes suppression validation.
    publication.tracks.sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at)); // Normalizes track ordering for deterministic rendering.
    if (Array.isArray(publication.announcements)) publication.announcements.sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at)); // Normalizes speech ordering for deterministic timing.
} // Finishes publication validation.

function get_loaded_track_records() { // Flattens loaded immutable publications into track records with publication precedence attached.
    const records = []; // Collects merged archive candidates.
    for (const [path, publication] of loaded_publications.entries()) { // Reads every currently relevant publication.
        const published_at = publication.published_at; // Reads the immutable publication time used for conflict resolution.
        for (const track of publication.tracks) records.push({ track, path, published_at }); // Attaches publication identity to every scheduled track.
    } // Finishes publication flattening.
    return records; // Returns candidates for live and upcoming resolution.
} // Finishes merged record creation.


function get_loaded_suppression_records() { // Flattens schema-3 safe-edit intervals with publication precedence attached.
    const records = []; // Collects currently loaded suppression candidates.
    for (const [path, publication] of loaded_publications.entries()) { // Reads each relevant immutable publication.
        const published_at = publication.published_at; // Reads the publication timestamp used for edit precedence.
        for (const suppression of publication.suppressions || []) records.push({ suppression, path, published_at }); // Attaches publication identity to every suppression interval.
    } // Finishes suppression flattening.
    return records; // Returns append-only edit intervals for live and upcoming resolution.
} // Finishes suppression record creation.

function record_is_newer(left, right) { // Compares two archive records using publication time and immutable path as a stable tie-breaker.
    const time_difference = Date.parse(left.published_at) - Date.parse(right.published_at); // Compares publication clocks first.
    if (time_difference !== 0) return time_difference > 0; // Reports whether the left record was published later.
    return String(left.path) > String(right.path); // Uses immutable path ordering only for the extremely rare equal-timestamp case.
} // Finishes publication precedence comparison.

function track_is_suppressed(record, instant_ms) { // Checks whether a newer append-only edit suppresses an older track at one instant.
    return get_loaded_suppression_records().some(suppression_record => { // Searches relevant suppression intervals for one newer publication.
        if (!record_is_newer(suppression_record, record)) return false; // Prevents a publication from suppressing itself or anything newer.
        const start_ms = Date.parse(suppression_record.suppression.starts_at); // Reads the suppression beginning.
        const end_ms = Date.parse(suppression_record.suppression.ends_at); // Reads the suppression end.
        return instant_ms >= start_ms && instant_ms < end_ms; // Reports whether this instant is cancelled for the older track.
    }); // Finishes suppression lookup.
} // Finishes safe-edit suppression resolution.

function get_loaded_announcement_records() { // Flattens archived Piper announcements with their publication precedence attached.
    const records = []; // Collects currently loaded announcement candidates.
    for (const [path, publication] of loaded_publications.entries()) { // Reads each relevant immutable publication.
        const published_at = publication.published_at; // Reads the publication timestamp used for conflict resolution.
        for (const announcement of publication.announcements || []) records.push({ announcement, path, published_at }); // Attaches publication identity to each speech clip.
    } // Finishes announcement flattening.
    return records; // Returns candidates for live speech resolution.
} // Finishes merged announcement record creation.

function get_live_announcement(now_ms = Date.now()) { // Resolves the authoritative Piper clip that should be audible at an exact instant.
    const live = get_live_state(now_ms); // Resolves the authoritative song publication first so obsolete speech cannot leak through.
    if (!live) return null; // Suppresses announcements when no song is currently authoritative.
    const candidates = get_loaded_announcement_records().filter(record => { // Finds clips from the winning song publication that cover this instant.
        if (record.path !== live.path || Date.parse(record.published_at) > now_ms) return false; // Rejects speech from superseded or not-yet-published schedules.
        const start_ms = Date.parse(record.announcement.starts_at); // Reads the archived speech start time.
        const end_ms = start_ms + Number(record.announcement.duration_seconds) * 1000; // Calculates the speech end time.
        return now_ms >= start_ms && now_ms < end_ms; // Keeps only the currently active speech interval.
    }); // Finishes active speech filtering.
    if (candidates.length === 0) return null; // Reports that no presenter clip is active right now.
    candidates.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) || Date.parse(b.announcement.starts_at) - Date.parse(a.announcement.starts_at)); // Applies newest-publication precedence deterministically.
    return candidates[0]; // Returns the authoritative clip.
} // Finishes live announcer resolution.

function get_live_state(now_ms = Date.now()) { // Resolves the winning scheduled item and offset for an authoritative time.
    const candidates = get_loaded_track_records().filter(record => { // Finds every loaded track whose interval covers the requested instant.
        const start_ms = Date.parse(record.track.starts_at); // Converts its start timestamp to milliseconds.
        const end_ms = start_ms + Number(record.track.duration_seconds) * 1000; // Calculates the scheduled end timestamp.
        return Date.parse(record.published_at) <= now_ms && now_ms >= start_ms && now_ms < end_ms && !track_is_suppressed(record, now_ms); // Keeps only published, covering tracks not cancelled by a newer append-only edit.
    }); // Finishes live candidate filtering.
    if (candidates.length === 0) return null; // Reports off-air time when no loaded publication covers the current instant.
    candidates.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) || Date.parse(b.track.starts_at) - Date.parse(a.track.starts_at)); // Gives the newest publication deterministic precedence over older overlapping schedules.
    const winner = candidates[0]; // Selects the currently authoritative publication and track.
    const start_ms = Date.parse(winner.track.starts_at); // Reads the winning track start time.
    return { ...winner, offset_seconds: (now_ms - start_ms) / 1000 }; // Returns the exact live item and seek offset.
} // Finishes live-state resolution.

function get_upcoming_tracks(now_ms = Date.now()) { // Resolves the rolling next 72 hours while suppressing entries superseded by newer publications or edit intervals.
    const horizon_ms = now_ms + schedule_window_ms; // Calculates the exclusive end of the listener-visible rolling window.
    const records = get_loaded_track_records().filter(record => { // Keeps current and future tracks available during the rolling window.
        const start_ms = Date.parse(record.track.starts_at); // Reads the archived track start.
        const end_ms = start_ms + Number(record.track.duration_seconds) * 1000; // Calculates the archived track end.
        return Date.parse(record.published_at) <= now_ms && end_ms > now_ms && start_ms < horizon_ms; // Keeps published tracks intersecting the next 72 hours.
    }); // Finishes rolling-window filtering.
    const visible = records.filter(record => { // Removes tracks whose first relevant instant is owned by a newer track or suppression.
        const sample_ms = Math.max(now_ms, Date.parse(record.track.starts_at)) + 1; // Chooses an instant just inside the candidate's relevant interval.
        if (track_is_suppressed(record, sample_ms)) return false; // Removes old tracks explicitly cancelled by a safe edit publication.
        const covering = records.filter(other => { // Finds every unsuppressed candidate publication covering that instant.
            const start_ms = Date.parse(other.track.starts_at); // Reads the competing track start.
            const end_ms = start_ms + Number(other.track.duration_seconds) * 1000; // Reads the competing track end.
            return sample_ms >= start_ms && sample_ms < end_ms && !track_is_suppressed(other, sample_ms); // Keeps active competing tracks that survive safe-edit suppression.
        }); // Finishes overlap lookup.
        covering.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) || String(b.path).localeCompare(String(a.path)) || Date.parse(b.track.starts_at) - Date.parse(a.track.starts_at)); // Applies deterministic newest-publication precedence.
        return covering.length === 0 || covering[0] === record; // Keeps only the track authoritative at its first relevant instant.
    }); // Finishes superseded-track filtering.
    visible.sort((a, b) => Date.parse(a.track.starts_at) - Date.parse(b.track.starts_at) || Date.parse(b.published_at) - Date.parse(a.published_at)); // Orders the rolling schedule chronologically.
    return visible; // Returns the authoritative next three days.
} // Finishes upcoming-track resolution.

function render_station() { // Refreshes all listener-facing schedule information.
    const live = get_live_state(); // Resolves what should be on air now.
    active_track = live ? live.track : null; // Stores the currently expected track.
    live_badge.textContent = live ? "LIVE" : "OFF AIR"; // Shows station state.
    if (!live) { // Handles gaps or dates outside published programming.
        track_title.textContent = "No Track Scheduled"; // Explains the absence of playback.
        track_meta.textContent = "Check the upcoming schedule."; // Directs attention to future items.
        progress_fill.style.width = "0%"; // Clears stale progress information.
        elapsed.textContent = "00:00"; // Clears stale elapsed time.
        remaining.textContent = "00:00"; // Clears stale remaining time.
        render_up_next(); // Shows the next available scheduled entries.
        return; // Stops current-track rendering.
    } // Finishes off-air handling.
    track_title.textContent = live.track.title || "Untitled"; // Shows the current track title.
    track_meta.textContent = live.track.artist || ""; // Shows optional artist information.
    update_progress(live); // Updates timeline progress for the live track.
    render_up_next(); // Shows tracks following the current one.
} // Finishes station rendering.

function render_up_next() { // Builds a scrollable authoritative schedule covering the next rolling 72 hours.
    up_next.replaceChildren(); // Removes rows and day headings from the previous render.
    const now_ms = Date.now(); // Captures a consistent time for the rolling window.
    const live = get_live_state(now_ms); // Resolves the current authoritative track so it can be excluded from the future list.
    const candidates = get_upcoming_tracks(now_ms).filter(record => !live || record.track !== live.track || record.published_at !== live.published_at); // Selects every authoritative future entry in the rolling three-day window.
    let active_day = ""; // Tracks the station-local calendar day currently being rendered.
    for (const record of candidates) { // Creates grouped rows for every upcoming item.
        const track = record.track; // Reads the scheduled track data.
        const start_ms = Date.parse(track.starts_at); // Converts its absolute start for display grouping.
        const day_key = format_day_key(start_ms); // Calculates the station-local calendar key.
        if (day_key !== active_day) { // Adds one sticky day heading when the rolling schedule crosses midnight.
            active_day = day_key; // Records the newly active date group.
            const heading = document.createElement("div"); // Creates the schedule day heading.
            heading.className = "queue_day"; // Applies sticky date styling inside the scrolling queue.
            heading.textContent = format_day_heading(start_ms); // Displays the configured station-local date.
            up_next.append(heading); // Adds the heading before its first scheduled song.
        } // Finishes date heading creation.
        const row = document.createElement("div"); // Creates the queue row container.
        row.className = "queue_item"; // Applies queue row styling.
        const time = document.createElement("div"); // Creates the scheduled time column.
        time.className = "queue_time"; // Applies time styling.
        time.textContent = format_clock(start_ms); // Formats the authoritative start time.
        const info = document.createElement("div"); // Creates the track information column.
        const title = document.createElement("div"); // Creates the title element.
        title.className = "queue_title"; // Applies title styling.
        title.textContent = track.title || "Untitled"; // Displays the scheduled title.
        const meta = document.createElement("div"); // Creates secondary metadata.
        meta.className = "queue_meta"; // Applies metadata styling.
        meta.textContent = track.artist || `YouTube: ${track.youtube_id}`; // Displays artist or a useful fallback.
        info.append(title, meta); // Groups the track information.
        row.append(time, info); // Completes the queue row.
        up_next.append(row); // Adds the row to the upcoming list.
    } // Finishes upcoming item rendering.
    if (candidates.length === 0) { // Handles an archive with no programming in the rolling window.
        const empty = document.createElement("div"); // Creates a concise empty-queue message.
        empty.className = "queue_meta queue_empty"; // Reuses subdued queue text styling with roomy empty-state spacing.
        empty.textContent = "Nothing scheduled in the next 72 hours."; // Explains the rolling-window boundary.
        up_next.append(empty); // Displays the empty-state message.
    } // Finishes empty queue handling.
} // Finishes upcoming schedule rendering.

function format_day_key(timestamp_ms) { // Builds a stable station-local date key for schedule grouping.
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: manifest?.timezone || "UTC" }).format(new Date(timestamp_ms)); // Returns a timezone-aware calendar key.
} // Finishes day key formatting.

function format_day_heading(timestamp_ms) { // Formats a readable station-local date heading for the rolling queue.
    return new Intl.DateTimeFormat([], { weekday: "long", day: "numeric", month: "long", timeZone: manifest?.timezone || "UTC" }).format(new Date(timestamp_ms)); // Produces the listener-facing day label.
} // Finishes day heading formatting.

function update_progress(live) { // Updates the progress bar and time labels from station time.
    const duration = Number(live.track.duration_seconds); // Reads the scheduled track duration.
    const position = Math.max(0, Math.min(duration, live.offset_seconds)); // Clamps the expected position to the track bounds.
    progress_fill.style.width = `${(position / duration) * 100}%`; // Draws proportional progress.
    elapsed.textContent = format_duration(position); // Displays elapsed station time.
    remaining.textContent = `-${format_duration(duration - position)}`; // Displays remaining station time.
} // Finishes progress rendering.

function cancel_volume_fade() { // Invalidates the currently running asynchronous volume envelope.
    volume_fade_generation += 1; // Causes the next fade step to stop without touching the newer audio state.
} // Finishes fade cancellation.

function fade_music_volume(target_volume, duration_ms) { // Moves YouTube volume smoothly with bounded cross-frame API traffic.
    if (!player_ready || muted || typeof player.getVolume !== "function" || typeof player.setVolume !== "function") return Promise.resolve(false); // Skips fades when music cannot or should not be audible.
    const generation = ++volume_fade_generation; // Claims this envelope and invalidates any older one.
    const start_volume = Math.max(0, Math.min(100, Number(player.getVolume()) || 0)); // Captures the actual current player level.
    const target = Math.max(0, Math.min(100, Number(target_volume) || 0)); // Clamps the target to the YouTube volume range.
    if (Math.abs(start_volume - target) < 0.5 || duration_ms <= 0) { player.setVolume(target); return Promise.resolve(true); } // Completes trivial changes without scheduling timers.
    const started_at = performance.now(); // Uses a monotonic clock so system clock changes cannot disturb the fade.
    return new Promise(resolve => { // Resolves when the envelope completes or is superseded.
        const step = () => { // Applies one low-overhead volume step.
            if (generation !== volume_fade_generation || muted || !player_ready) { resolve(false); return; } // Stops stale fades after mute, player loss, or a newer envelope.
            const progress = Math.min(1, (performance.now() - started_at) / duration_ms); // Measures normalized fade progress.
            const eased = progress * progress * (3 - 2 * progress); // Uses smoothstep easing to avoid abrupt starts and stops.
            player.setVolume(Math.round(start_volume + (target - start_volume) * eased)); // Applies an integer interpolated bed level through the iframe API.
            if (progress >= 1) { player.setVolume(target); resolve(true); return; } // Pins the exact target at completion.
            window.setTimeout(step, volume_fade_step_ms); // Schedules the next bounded-frequency volume update.
        }; // Finishes one fade step.
        step(); // Starts the envelope immediately.
    }); // Finishes fade promise construction.
} // Finishes smooth music fading.

async function duck_music_for_announcer() { // Fades YouTube music down while preserving the listener's chosen level for restoration.
    if (!player_ready || muted || typeof player.getVolume !== "function" || typeof player.setVolume !== "function") return false; // Avoids changing an unavailable or intentionally muted player.
    if (ducked_volume === null) ducked_volume = Number(player.getVolume()); // Captures the music level only once for the active speech clip.
    const current_volume = Number.isFinite(ducked_volume) ? ducked_volume : 100; // Falls back safely when the iframe reports an unexpected value.
    return fade_music_volume(Math.min(current_volume, announcer_duck_volume), announcer_fade_down_ms); // Lowers louder music smoothly while leaving already-quiet playback unchanged.
} // Finishes radio-style music ducking.

function restore_music_after_announcer() { // Fades back to the exact pre-announcement YouTube volume.
    if (ducked_volume === null) return; // Stops when no announcer changed the music level.
    const restore_volume = ducked_volume; // Captures the listener's original level before releasing speech state.
    ducked_volume = null; // Clears the saved level so a later announcement can capture a fresh listener setting.
    if (!muted) void fade_music_volume(restore_volume, announcer_fade_up_ms); // Returns music gently without delaying announcer cleanup.
} // Finishes music restoration.

function stop_announcer(mark_played = false) { // Stops the current speech clip and releases music ducking.
    const stopped_key = active_announcement_key; // Captures the identity before resetting the media element.
    if (mark_played && stopped_key) played_announcements.add(stopped_key); // Prevents a completed clip from restarting within its original interval.
    active_announcement_key = ""; // Clears speech identity before media reset events can fire.
    announcer_audio.pause(); // Stops local presenter audio immediately.
    announcer_audio.removeAttribute("src"); // Releases the completed immutable WAV resource.
    announcer_audio.load(); // Resets the media element cleanly for its next archived clip.
    restore_music_after_announcer(); // Returns music to the listener's prior volume.
} // Finishes announcer cleanup.

async function play_announcer(record, now_ms) { // Starts one immutable Piper clip at the correct live offset.
    const key = `${record.path}:${record.announcement.id}`; // Creates a globally stable in-page identity for this archived clip.
    if (played_announcements.has(key) || active_announcement_key === key) return; // Prevents duplicate starts from the fast timing loop.
    stop_announcer(false); // Ends any obsolete speech before switching to a newer authoritative clip.
    active_announcement_key = key; // Claims the clip before asynchronous media loading to prevent racing starts.
    announcer_audio.muted = muted; // Applies the station's current custom mute state to local speech.
    announcer_audio.src = new URL(record.announcement.audio_path, document.baseURI).href; // Resolves the immutable WAV relative to the deployed GitHub Pages site.
    announcer_audio.load(); // Begins loading the archived Piper output.
    try { // Handles browsers that can reject delayed media starts.
        await new Promise((resolve, reject) => { // Waits until seeking into the speech clip is supported.
            const on_ready = () => { cleanup(); resolve(); }; // Completes when media metadata is available.
            const on_error = () => { cleanup(); reject(new Error("Announcer audio could not be loaded")); }; // Converts media errors into a useful station message.
            const cleanup = () => { announcer_audio.removeEventListener("loadedmetadata", on_ready); announcer_audio.removeEventListener("error", on_error); }; // Removes one-shot listeners after either outcome.
            announcer_audio.addEventListener("loadedmetadata", on_ready); // Waits for clip duration and seeking support.
            announcer_audio.addEventListener("error", on_error); // Detects missing or invalid archived audio.
        }); // Finishes media readiness wait.
        if (active_announcement_key !== key) return; // Abandons a clip superseded while its media was loading.
        await duck_music_for_announcer(); // Fades the music bed down before the presenter enters.
        if (active_announcement_key !== key) return; // Abandons speech if a newer schedule state superseded it during the fade.
        const offset_seconds = Math.max(0, (Date.now() - Date.parse(record.announcement.starts_at)) / 1000); // Recalculates live speech position after metadata loading and the fade-down interval.
        if (offset_seconds >= Number(record.announcement.duration_seconds)) { stop_announcer(true); return; } // Skips a link that expired while the bed was fading.
        announcer_audio.currentTime = Math.min(offset_seconds, Math.max(0, Number(record.announcement.duration_seconds) - 0.05)); // Seeks into the clip so the station remains timeline-accurate.
        await announcer_audio.play(); // Starts the local Piper clip over the now-ducked YouTube bed.
    } catch (error) { // Handles blocked playback or missing announcement media.
        if (active_announcement_key === key) stop_announcer(false); // Restores music only when this failed clip is still active.
        set_status(`Announcer unavailable: ${error.message}`, true); // Reports the speech problem while leaving music playback running.
    } // Finishes announcer playback attempt.
} // Finishes local announcer clip playback.

function synchronize_announcer() { // Keeps local Piper speech aligned with the currently authoritative schedule publication.
    if (!joined_live || !player_ready) { // Suppresses speech until the listener has explicitly joined the station.
        if (active_announcement_key) stop_announcer(false); // Stops speech if the listener leaves the playable state.
        return; // Stops timing work until playback is active.
    } // Finishes join-state handling.
    const now_ms = Date.now(); // Captures one authoritative instant for this resolver pass.
    const record = get_live_announcement(now_ms); // Finds the speech clip scheduled for this exact instant.
    if (!record) { // Handles normal periods between presenter links.
        if (active_announcement_key) stop_announcer(true); // Ends a clip whose archived speech interval has completed.
        return; // Leaves music at its normal volume until the next presenter link.
    } // Finishes no-announcement handling.
    const key = `${record.path}:${record.announcement.id}`; // Creates the same stable identity used by the playback guard.
    if (played_announcements.has(key) || active_announcement_key === key) return; // Avoids repeats and redundant media operations.
    play_announcer(record, now_ms); // Starts the newly active local speech clip at its live offset.
} // Finishes announcer synchronization.

function unlock_announcer_audio() { // Primes the reusable audio element during the listener's explicit Join Live gesture.
    const silent_wav = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="; // Provides a tiny silent WAV that requires no network request.
    announcer_audio.src = silent_wav; // Loads the harmless primer into the reusable speech element.
    announcer_audio.volume = 1; // Keeps future Piper speech at its original mastered level.
    announcer_audio.muted = true; // Guarantees the media-unlock primer itself is inaudible.
    const promise = announcer_audio.play(); // Starts media directly inside the user gesture to satisfy browser autoplay policy.
    if (promise && typeof promise.finally === "function") promise.catch(() => {}).finally(() => { announcer_audio.pause(); announcer_audio.removeAttribute("src"); announcer_audio.load(); announcer_audio.muted = muted; }); // Resets the element while preserving the station mute state without surfacing primer-playback rejection.
} // Finishes browser media priming.

announcer_audio.addEventListener("ended", () => stop_announcer(true)); // Restores music immediately when a Piper clip naturally finishes.
announcer_audio.addEventListener("error", () => { if (active_announcement_key) stop_announcer(false); }); // Prevents a broken speech file from leaving music permanently ducked.

function synchronize_playback(force_load) { // Keeps an opted-in listener aligned with the authoritative merged archive schedule.
    render_station(); // Refreshes station state before making playback decisions.
    if (!joined_live || !player_ready) return; // Avoids scripted playback before user consent or player readiness.
    const live = get_live_state(); // Resolves the exact expected item and position.
    if (!live) { // Handles intentional schedule gaps.
        if (typeof player.pauseVideo === "function") player.pauseVideo(); // Stops carrying an old track through an off-air gap.
        return; // Stops synchronization until another item becomes live.
    } // Finishes gap handling.
    const player_data = typeof player.getVideoData === "function" ? player.getVideoData() : {}; // Reads the currently loaded YouTube video identity.
    const loaded_id = player_data.video_id || ""; // Normalizes the loaded identifier.
    if (force_load || loaded_id !== live.track.youtube_id) { // Loads a different scheduled video or performs the initial join.
        player.loadVideoById({ videoId: live.track.youtube_id, startSeconds: Math.max(0, live.offset_seconds) }); // Starts the official YouTube player at the live station offset.
        active_track = live.track; // Records the loaded scheduled item.
        return; // Lets the player settle before drift correction.
    } // Finishes track-change handling.
    const actual = Number(player.getCurrentTime()); // Reads the listener's current playback position.
    if (Number.isFinite(actual) && Math.abs(actual - live.offset_seconds) > drift_tolerance_seconds) player.seekTo(Math.max(0, live.offset_seconds), true); // Corrects meaningful drift while ignoring tiny variations.
} // Finishes playback synchronization.

async function try_load_legacy_schedule(original_error) { // Supports an older station.json when the archive index has not been deployed yet.
    if (manifest || loaded_publications.size > 0) return false; // Avoids replacing a functioning archive after a later refresh failure.
    try { // Attempts the legacy format only as an initial compatibility path.
        const response = await fetch(`${legacy_schedule_url}?v=${Date.now()}`, { cache: "no-store" }); // Fetches the old replaceable schedule file.
        if (!response.ok) return false; // Stops when no legacy file exists.
        const legacy = await response.json(); // Parses the old station document.
        const published_at = legacy.generated_at || "1970-01-01T00:00:00Z"; // Gives legacy data deterministic lowest precedence.
        validate_publication({ ...legacy, published_at }, { path: "station.json", published_at }); // Reuses publication validation for the old track schema.
        const starts = legacy.tracks.map(track => Date.parse(track.starts_at)); // Collects legacy track starts for synthetic manifest coverage.
        const ends = legacy.tracks.map(track => Date.parse(track.starts_at) + Number(track.duration_seconds) * 1000); // Collects legacy track ends for synthetic manifest coverage.
        manifest = { station_name: legacy.station_name || "Cambell Frequency", timezone: legacy.timezone || "Europe/London", publications: legacy.tracks.length > 0 ? [{ path: "station.json", published_at, starts_at: new Date(Math.min(...starts)).toISOString(), ends_at: new Date(Math.max(...ends)).toISOString(), track_count: legacy.tracks.length }] : [] }; // Builds an in-memory compatibility index.
        loaded_publications.set("station.json", { ...legacy, published_at }); // Makes the old schedule participate in the merged resolver.
        station_name.textContent = manifest.station_name; // Applies the legacy station title.
        render_station(); // Updates listener information from the legacy file.
        synchronize_playback(false); // Applies the legacy schedule to active playback.
        set_status(`Using legacy station.json because the archive index is unavailable (${original_error.message}).`, false); // Makes the compatibility path visible for migration.
        return true; // Reports successful fallback.
    } catch (_) { // Treats malformed legacy data as unavailable.
        return false; // Allows the original archive error to be displayed.
    } // Finishes legacy fallback handling.
} // Finishes legacy schedule compatibility.

function format_duration(total_seconds) { // Formats a duration as clock-like text.
    const seconds = Math.max(0, Math.floor(total_seconds)); // Normalizes fractional or negative values.
    const minutes = Math.floor(seconds / 60); // Calculates whole minutes.
    const remainder = seconds % 60; // Calculates remaining seconds.
    return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`; // Returns a stable display value.
} // Finishes duration formatting.

function format_clock(timestamp_ms) { // Formats a scheduled timestamp in the station's configured timezone.
    return new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: manifest?.timezone || "UTC" }).format(new Date(timestamp_ms)); // Uses station time instead of listener-local time.
} // Finishes scheduled clock formatting.

function set_status(message, is_error) { // Updates the small operational status line.
    status.textContent = message; // Displays the latest status message.
    status.classList.toggle("error", is_error); // Highlights failures without changing layout.
} // Finishes status updates.

mute_button.addEventListener("click", toggle_mute); // Routes custom UI mute input to the YouTube player.
update_mute_button(); // Initializes the custom mute control before the player becomes ready.
join_button.addEventListener("click", () => { // Starts live playback from an explicit browser gesture.
    unlock_announcer_audio(); // Primes the local Piper audio element while browser media playback is explicitly authorized.
    joined_live = true; // Enables ongoing synchronization.
    join_button.disabled = true; // Prevents duplicate start actions.
    join_button.textContent = "Listening Live"; // Confirms listener state.
    synchronize_playback(true); // Loads the current scheduled video at its live offset.
}); // Finishes join action wiring.

load_station_data(); // Loads the archive immediately.
refresh_timer = window.setInterval(load_station_data, refresh_interval_ms); // Polls GitHub Pages for newly published archive entries.
sync_timer = window.setInterval(() => synchronize_playback(false), sync_interval_ms); // Corrects track changes and meaningful playback drift.
announcer_timer = window.setInterval(synchronize_announcer, announcer_poll_interval_ms); // Resolves short locally hosted presenter links with sub-second timing.

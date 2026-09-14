#ifndef PrefsKeys_h
#define PrefsKeys_h

// Shared NVS (Preferences) namespace/keys used to persist calibration values
// (top distance between hangers, pen servo angle) across firmware restarts.
static const char* PREFS_NAMESPACE = "mural";
static const char* PREFS_TOP_DISTANCE_KEY = "topDistance";
static const char* PREFS_PEN_ANGLE_KEY = "penAngle";

// Pen-holder geometry, calibrated once per machine rather than per plot (see
// docs/pen-servo.md). The holder is a cam: below the lowest locked angle or
// above the highest, the pen is not properly retained, and a little beyond the
// highest is the position where it can be lifted out and replaced. The drawing
// contact point (PREFS_PEN_ANGLE_KEY above) lives between the two locked
// limits, which is why those bound it rather than the servo's full 0-180 range.
static const char* PREFS_PEN_LOWEST_KEY = "penLowest";
static const char* PREFS_PEN_HIGHEST_KEY = "penHighest";
static const char* PREFS_PEN_UNLOCKED_KEY = "penUnlocked";

// NVS namespace/keys used to checkpoint an in-progress drawing (see Runner)
// so it can be resumed after a power loss. Written before executing each
// command line (throttled - see Runner::checkpointIntervalLines), so a
// checkpoint always describes a position at-or-before the belts' true
// physical position, never after it. Cleared on successful completion, on a
// new upload, or when the user discards a resume offer.
static const char* PREFS_CKPT_NAMESPACE = "mural-ckpt";
static const char* PREFS_CKPT_VALID_KEY = "valid";
static const char* PREFS_CKPT_OFFSET_KEY = "offset";
static const char* PREFS_CKPT_EXEC_LINES_KEY = "execLines";
static const char* PREFS_CKPT_X_KEY = "x";
static const char* PREFS_CKPT_Y_KEY = "y";
static const char* PREFS_CKPT_TOP_DIST_KEY = "topDist";
static const char* PREFS_CKPT_PEN_ANGLE_KEY = "penAngle";
// Whether the pen was down (mid-stroke) at the moment this checkpoint was
// written - see Runner::Checkpoint's doc comment.
static const char* PREFS_CKPT_PEN_DOWN_KEY = "penDown";
// Multi-color (docs/multi-color.md): which pen was mounted/active at the
// moment this checkpoint was written, so a resume offer can tell the user
// which pen must be (re-)inserted. colorIndex defaults to 1 and colorName to
// "" for single-color files/jobs that never saw a c<index> command - see
// Runner::writeCheckpoint().
static const char* PREFS_CKPT_COLOR_INDEX_KEY = "colorIdx";
static const char* PREFS_CKPT_COLOR_NAME_KEY = "colorName";

#endif

// N-API port of piper1-gpl `src/piper/espeakbridge.c` (GPL-3.0-or-later).
// Exposes: initialize(dataDir), setVoice(name), getPhonemes(text).
// getPhonemes returns an array of { phonemes, terminator, endOfSentence }.

#include <stdlib.h>
#include <string.h>
#include <node_api.h>

#include <espeak-ng/speak_lib.h>

#define CLAUSE_INTONATION_FULL_STOP 0x00000000
#define CLAUSE_INTONATION_COMMA 0x00001000
#define CLAUSE_INTONATION_QUESTION 0x00002000
#define CLAUSE_INTONATION_EXCLAMATION 0x00003000

#define CLAUSE_TYPE_CLAUSE 0x00040000
#define CLAUSE_TYPE_SENTENCE 0x00080000

#define CLAUSE_PERIOD (40 | CLAUSE_INTONATION_FULL_STOP | CLAUSE_TYPE_SENTENCE)
#define CLAUSE_COMMA (20 | CLAUSE_INTONATION_COMMA | CLAUSE_TYPE_CLAUSE)
#define CLAUSE_QUESTION (40 | CLAUSE_INTONATION_QUESTION | CLAUSE_TYPE_SENTENCE)
#define CLAUSE_EXCLAMATION (45 | CLAUSE_INTONATION_EXCLAMATION | CLAUSE_TYPE_SENTENCE)
#define CLAUSE_COLON (30 | CLAUSE_INTONATION_FULL_STOP | CLAUSE_TYPE_CLAUSE)
#define CLAUSE_SEMICOLON (30 | CLAUSE_INTONATION_COMMA | CLAUSE_TYPE_CLAUSE)

static int g_initialized = 0;

static napi_value make_error(napi_env env, const char *msg) {
    napi_value err_msg, err;
    napi_create_string_utf8(env, msg, NAPI_AUTO_LENGTH, &err_msg);
    napi_create_error(env, NULL, err_msg, &err);
    return err;
}

static int get_string_arg(napi_env env, napi_value arg, char *out, size_t out_len) {
    size_t len = 0;
    napi_status s = napi_get_value_string_utf8(env, arg, out, out_len, &len);
    return (s == napi_ok) ? 0 : -1;
}

static napi_value js_initialize(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    if (argc < 1) {
        napi_throw(env, make_error(env, "initialize(dataDir) requires 1 argument"));
        return NULL;
    }
    char data_dir[1024];
    if (get_string_arg(env, argv[0], data_dir, sizeof(data_dir)) != 0) {
        napi_throw(env, make_error(env, "initialize(dataDir) requires a string"));
        return NULL;
    }
    if (!g_initialized) {
        if (espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, 0, data_dir, 0) < 0) {
            napi_throw(env, make_error(env, "Failed to initialize espeak-ng"));
            return NULL;
        }
        g_initialized = 1;
    }
    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

static napi_value js_set_voice(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    if (argc < 1) {
        napi_throw(env, make_error(env, "setVoice(name) requires 1 argument"));
        return NULL;
    }
    char voice[256];
    if (get_string_arg(env, argv[0], voice, sizeof(voice)) != 0) {
        napi_throw(env, make_error(env, "setVoice(name) requires a string"));
        return NULL;
    }
    if (espeak_SetVoiceByName(voice) != EE_OK) {
        char msg[300];
        snprintf(msg, sizeof(msg), "Failed to set voice: %s", voice);
        napi_throw(env, make_error(env, msg));
        return NULL;
    }
    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

static const char *terminator_for(int terminator) {
    int t = terminator & 0x000FFFFF;
    if (t == CLAUSE_PERIOD) return ".";
    if (t == CLAUSE_QUESTION) return "?";
    if (t == CLAUSE_EXCLAMATION) return "!";
    if (t == CLAUSE_COMMA) return ",";
    if (t == CLAUSE_COLON) return ":";
    if (t == CLAUSE_SEMICOLON) return ";";
    return "";
}

static napi_value js_get_phonemes(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    if (argc < 1) {
        napi_throw(env, make_error(env, "getPhonemes(text) requires 1 argument"));
        return NULL;
    }
    size_t text_len = 0;
    napi_get_value_string_utf8(env, argv[0], NULL, 0, &text_len);
    char *text_buf = (char *)malloc(text_len + 1);
    if (!text_buf) {
        napi_throw(env, make_error(env, "Out of memory"));
        return NULL;
    }
    napi_get_value_string_utf8(env, argv[0], text_buf, text_len + 1, NULL);

    napi_value result;
    napi_create_array(env, &result);
    uint32_t idx = 0;

    const void *cursor = text_buf;
    // espeak_TextToPhonemesWithTerminator advances the pointer; it returns
    // NULL when input is exhausted (mirrors the python bridge while loop).
    while (cursor != NULL) {
        int terminator = 0;
        const char *phonemes = espeak_TextToPhonemesWithTerminator(
            &cursor, espeakCHARS_AUTO, espeakPHONEMES_IPA, &terminator);
        if (phonemes == NULL) {
            phonemes = "";
        }
        const char *term_str = terminator_for(terminator);
        int end_of_sentence = (terminator & CLAUSE_TYPE_SENTENCE) == CLAUSE_TYPE_SENTENCE;

        napi_value item, js_phonemes, js_term, js_eos;
        napi_create_object(env, &item);
        napi_create_string_utf8(env, phonemes, NAPI_AUTO_LENGTH, &js_phonemes);
        napi_create_string_utf8(env, term_str, NAPI_AUTO_LENGTH, &js_term);
        napi_get_boolean(env, end_of_sentence, &js_eos);
        napi_set_named_property(env, item, "phonemes", js_phonemes);
        napi_set_named_property(env, item, "terminator", js_term);
        napi_set_named_property(env, item, "endOfSentence", js_eos);
        napi_set_element(env, result, idx++, item);
    }

    free(text_buf);
    return result;
}

#define EXPORT_FN(env, exports, name, fn)                                       \
    do {                                                                        \
        napi_value f;                                                           \
        napi_create_function(env, name, NAPI_AUTO_LENGTH, fn, NULL, &f);         \
        napi_set_named_property(env, exports, name, f);                         \
    } while (0)

static void env_cleanup(void *arg) {
    (void)arg;
    if (g_initialized) {
        espeak_Terminate();
        g_initialized = 0;
    }
}

static napi_value init(napi_env env, napi_value exports) {
    napi_add_env_cleanup_hook(env, env_cleanup, NULL);
    EXPORT_FN(env, exports, "initialize", js_initialize);
    EXPORT_FN(env, exports, "setVoice", js_set_voice);
    EXPORT_FN(env, exports, "getPhonemes", js_get_phonemes);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)

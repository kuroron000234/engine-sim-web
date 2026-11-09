#!/usr/bin/env python3
"""Apply web-port patches to an upstream engine-sim checkout (idempotent)."""
import re, sys, pathlib
root = pathlib.Path(sys.argv[1])

def edit(rel, fn):
    p = root / rel
    s = p.read_text()
    n = fn(s)
    if n != s:
        p.write_text(n)
        print("patched", rel)

# 1) piranha: Boost.Filesystem -> std::filesystem
def path_h(s):
    s = re.sub(r'// Forward Boost declaration\nnamespace boost \{.*?\} /\* namespace boost \*/\n',
               '#include <filesystem>\n', s, flags=re.S)
    return s.replace('boost::filesystem', 'std::filesystem')
edit('dependencies/submodules/piranha/include/path.h', path_h)

def path_cpp(s):
    s = s.replace('#include <boost/filesystem.hpp>', '#include <filesystem>')
    s = s.replace('boost::filesystem', 'std::filesystem').replace('is_complete()', 'is_absolute()')
    # equivalent() throws when a path does not exist; compare normalized paths instead
    s = s.replace('return std::filesystem::equivalent(this->getBoostPath(), path.getBoostPath());',
                  'std::error_code ec;\n    if (std::filesystem::exists(*m_path, ec) && std::filesystem::exists(path.getBoostPath(), ec))\n'
                  '        return std::filesystem::equivalent(this->getBoostPath(), path.getBoostPath(), ec);\n'
                  '    return m_path->lexically_normal() == path.getBoostPath().lexically_normal();')
    return s
edit('dependencies/submodules/piranha/src/path.cpp', path_cpp)

# 2) synthesizer: no Delta Studio, and a non-blocking render for single-threaded builds
def synth(s):
    s = s.replace('#include "../include/delta.h"\n', '')
    old = '''    m_cv0.wait(lk0, [this] {
        const bool inputAvailable =
            m_inputChannels[0].data.size() > 0
            && m_audioBuffer.size() < 2000;
        return !m_run || (inputAvailable && !m_processed);
    });'''
    new = '''#ifdef ESWEB_SINGLE_THREAD
    {
        const bool inputAvailable =
            m_inputChannels[0].data.size() > 0
            && m_audioBuffer.size() < 2000;
        if (!(inputAvailable && !m_processed)) return;
    }
#else
''' + old + '''
#endif'''
    if 'ESWEB_SINGLE_THREAD' not in s:
        s = s.replace(old, new)
    return s
edit('src/synthesizer.cpp', synth)

# 3) MSVC-only constructs
for d in ['src', 'include', 'scripting/src', 'scripting/include',
          'dependencies/submodules/piranha/src', 'dependencies/submodules/piranha/include',
          'dependencies/submodules/simple-2d-constraint-solver/src',
          'dependencies/submodules/simple-2d-constraint-solver/include']:
    for p in (root / d).glob('*.[ch]*'):
        rel = str(p.relative_to(root))
        edit(rel, lambda s: re.sub(r'(#include\s+")([^"]*)"',
                                   lambda m: m.group(1) + m.group(2).replace('\\', '/') + '"', s))

def gas(s):
    old = '''        struct Mix {
            double p_fuel = 0.0;
            double p_inert = 1.0;
            double p_o2 = 0.0;
        };
'''
    if old in s:
        s = s.replace(old, '        using Mix = GasSystemMix;\n')
        s = s.replace('class GasSystem {', 'struct GasSystemMix {\n    double p_fuel = 0.0;\n    double p_inert = 1.0;\n    double p_o2 = 0.0;\n};\n\nclass GasSystem {', 1)
    return s
edit('include/gas_system.h', gas)
edit('include/ring_buffer.h', lambda s: s.replace('if (start + index < m_capacity)', 'if (m_start + index < m_capacity)'))
edit('scripting/include/object_reference_node.h', lambda s: s.replace(
    '        template <typename Type>\n        void overrideType() {\n            m_output.overrideType(LookupChannelType<Type>());',
    '        template <typename T_Override>\n        void overrideType() {\n            m_output.overrideType(LookupChannelType<T_Override>());'))
edit('dependencies/submodules/simple-2d-constraint-solver/include/sparse_matrix.h', lambda s: s.replace(
    'namespace atg_scs {\n    class Matrix;\n', '#include "matrix.h"\n\nnamespace atg_scs {\n', 1))
edit('src/synthesizer.cpp', lambda s: s.replace('if (fpclassify(v_in)', 'if (std::fpclassify(v_in)'))
for rel in ['include/units.h', 'include/constants.h']:
    if (root / rel).exists():
        edit(rel, lambda s: s.replace('extern constexpr', 'inline constexpr'))

# 4) Faster convolution: mirrored ring buffer -> one contiguous dot product (SIMD-friendly).
CONV_CPP = r'''#include "../include/convolution_filter.h"

#include <assert.h>
#include <string.h>
#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

// Web port: same result as upstream (sum of h[i] * x[n - i]) but the shift register is stored
// twice back to back, so the window is always contiguous and can be vectorized.

ConvolutionFilter::ConvolutionFilter() {
    m_shiftRegister = nullptr;
    m_impulseResponse = nullptr;
    m_shiftOffset = 0;
    m_sampleCount = 0;
}

ConvolutionFilter::~ConvolutionFilter() {
    assert(m_shiftRegister == nullptr);
    assert(m_impulseResponse == nullptr);
}

void ConvolutionFilter::initialize(int samples) {
    m_sampleCount = samples;
    m_shiftOffset = 0;
    const int padded = (samples + 3) & ~3;
    m_shiftRegister = new float[2 * padded + 4];
    m_impulseResponse = new float[padded + 4];
    memset(m_shiftRegister, 0, sizeof(float) * (2 * padded + 4));
    memset(m_impulseResponse, 0, sizeof(float) * (padded + 4));
}

void ConvolutionFilter::destroy() {
    delete[] m_shiftRegister;
    delete[] m_impulseResponse;
    m_shiftRegister = nullptr;
    m_impulseResponse = nullptr;
}

float ConvolutionFilter::f(float sample) {
    const int n = m_sampleCount;
    if (n <= 0) return 0.0f;
    m_shiftRegister[m_shiftOffset] = sample;
    m_shiftRegister[m_shiftOffset + n] = sample;

    const float *x = m_shiftRegister + m_shiftOffset;
    const float *h = m_impulseResponse;
    float result;
#ifdef __wasm_simd128__
    v128_t acc0 = wasm_f32x4_splat(0.0f), acc1 = wasm_f32x4_splat(0.0f);
    int i = 0;
    for (; i + 8 <= n; i += 8) {
        acc0 = wasm_f32x4_add(acc0, wasm_f32x4_mul(wasm_v128_load(h + i), wasm_v128_load(x + i)));
        acc1 = wasm_f32x4_add(acc1, wasm_f32x4_mul(wasm_v128_load(h + i + 4), wasm_v128_load(x + i + 4)));
    }
    acc0 = wasm_f32x4_add(acc0, acc1);
    result = wasm_f32x4_extract_lane(acc0, 0) + wasm_f32x4_extract_lane(acc0, 1)
        + wasm_f32x4_extract_lane(acc0, 2) + wasm_f32x4_extract_lane(acc0, 3);
    for (; i < n; ++i) result += h[i] * x[i];
#else
    float a0 = 0, a1 = 0, a2 = 0, a3 = 0;
    int i = 0;
    for (; i + 4 <= n; i += 4) {
        a0 += h[i] * x[i]; a1 += h[i + 1] * x[i + 1];
        a2 += h[i + 2] * x[i + 2]; a3 += h[i + 3] * x[i + 3];
    }
    result = (a0 + a1) + (a2 + a3);
    for (; i < n; ++i) result += h[i] * x[i];
#endif

    m_shiftOffset = (m_shiftOffset - 1 + n) % n;
    return result;
}
'''
p = root / 'src/convolution_filter.cpp'
if 'Web port: same result' not in p.read_text():
    p.write_text(CONV_CPP)
    print('patched src/convolution_filter.cpp')

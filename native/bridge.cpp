// Web bridge for engine-sim (https://github.com/ange-yaghi/engine-sim, MIT).
// Replaces the Delta Studio application layer: loads .mr scripts, drives the
// simulator single-threaded, and exposes audio + state to JavaScript.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <atomic>
#include <map>
#include <set>
#include <random>
#include <chrono>

#define protected public
#define private public
#include "include/engine.h"
#include "include/simulator.h"
#include "include/piston_engine_simulator.h"
#include "include/transmission.h"
#include "include/vehicle.h"
#include "include/camshaft.h"
#include "include/cylinder_head.h"
#include "include/cylinder_bank.h"
#include "include/combustion_chamber.h"
#include "include/exhaust_system.h"
#include "include/impulse_response.h"
#include "include/units.h"
#include "include/constants.h"
#include "scripting/include/compiler.h"
#undef protected
#undef private

#include <cmath>
#include <cstring>
#include <filesystem>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define API extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define API extern "C"
#endif

namespace {

Engine *g_engine = nullptr;
Vehicle *g_vehicle = nullptr;
Transmission *g_transmission = nullptr;
Simulator *g_sim = nullptr;
ApplicationSettings g_settings;
std::string g_error;
std::string g_info;

std::vector<int16_t> g_audio;
std::vector<double> g_state(64, 0.0);
std::vector<double> g_frame;

// Control state (mirrors EngineSimApplication::processEngineInput)
double g_targetSpeedSetting = 0.0;
double g_speedSetting = 0.0;
double g_targetClutchPressure = 1.0;
double g_clutchPressure = 1.0;
double g_clutchRC = 0.001;
double g_dynoSpeed = 0.0;
double g_simSpeed = 1.0;
bool g_starter = false;
double g_physMs = 0, g_audioMs = 0;
double g_baseFreq = 10000;
double g_cutFactor = 0.3;
std::vector<std::vector<int16_t>> g_irs;
std::vector<float> g_irVolumes;
int g_irLimit = 10000;

double clamp01(double x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
double clampd(double x, double a, double b) { return x < a ? a : (x > b ? b : x); }

bool readWav(const std::string &path, std::vector<int16_t> &out) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    std::vector<char> d((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    if (d.size() < 12 || std::string(d.data(), 4) != "RIFF" || std::string(d.data() + 8, 4) != "WAVE") return false;
    size_t p = 12;
    int channels = 1, bits = 16;
    while (p + 8 <= d.size()) {
        const std::string id(d.data() + p, 4);
        uint32_t sz;
        std::memcpy(&sz, d.data() + p + 4, 4);
        const size_t body = p + 8;
        if (id == "fmt " && body + 16 <= d.size()) {
            uint16_t ch, bps;
            std::memcpy(&ch, d.data() + body + 2, 2);
            std::memcpy(&bps, d.data() + body + 14, 2);
            channels = ch; bits = bps;
        }
        else if (id == "data") {
            const size_t end = std::min(d.size(), body + sz);
            if (bits != 16) return false;
            const size_t frames = (end - body) / (2 * channels);
            out.resize(frames);
            for (size_t i = 0; i < frames; ++i) {
                int16_t s;
                std::memcpy(&s, d.data() + body + i * 2 * channels, 2);
                out[i] = s;
            }
            return true;
        }
        p = body + sz + (sz & 1);
    }
    return false;
}

void releaseAll() {
    if (g_sim != nullptr) {
        g_sim->releaseSimulation();
        delete g_sim;
        g_sim = nullptr;
    }
    delete g_vehicle; g_vehicle = nullptr;
    delete g_transmission; g_transmission = nullptr;
    if (g_engine != nullptr) {
        g_engine->destroy();
        delete g_engine;
        g_engine = nullptr;
    }
}

std::string jsonEscape(const std::string &s) {
    std::string r;
    for (char c : s) {
        if (c == '"' || c == '\\') { r += '\\'; r += c; }
        else if (c == '\n') r += "\\n";
        else if ((unsigned char)c < 0x20) r += ' ';
        else r += c;
    }
    return r;
}

void buildInfo() {
    std::ostringstream o;
    o.precision(9);
    Engine *e = g_engine;
    o << "{\"name\":\"" << jsonEscape(e->getName()) << "\"";
    o << ",\"redline\":" << e->getRedline();
    o << ",\"displacement\":" << e->getDisplacement();
    o << ",\"maxDepth\":" << e->getMaxDepth();
    o << ",\"simFreq\":" << g_sim->getSimulationFrequency();
    o << ",\"gearCount\":" << g_transmission->m_gearCount;
    o << ",\"dynoMin\":" << e->getDynoMinSpeed() << ",\"dynoMax\":" << e->getDynoMaxSpeed()
      << ",\"dynoStep\":" << e->getDynoHoldStep();
    o << ",\"units\":{\"speed\":\"" << g_settings.speedUnits << "\",\"pressure\":\"" << g_settings.pressureUnits
      << "\",\"torque\":\"" << g_settings.torqueUnits << "\",\"power\":\"" << g_settings.powerUnits << "\"}";
    o << ",\"colors\":[" << g_settings.colorBackground << "," << g_settings.colorForeground << ","
      << g_settings.colorShadow << "," << g_settings.colorHighlight1 << "," << g_settings.colorHighlight2 << ","
      << g_settings.colorPink << "," << g_settings.colorRed << "," << g_settings.colorOrange << ","
      << g_settings.colorYellow << "," << g_settings.colorBlue << "," << g_settings.colorGreen << "]";

    o << ",\"cranks\":[";
    for (int i = 0; i < e->getCrankshaftCount(); ++i) {
        Crankshaft *c = e->getCrankshaft(i);
        if (i) o << ",";
        o << "{\"throw\":" << c->getThrow() << ",\"x\":" << c->getPosX() << ",\"y\":" << c->getPosY() << ",\"journals\":[";
        for (int j = 0; j < c->getRodJournalCount(); ++j) o << (j ? "," : "") << c->getRodJournalAngle(j);
        o << "]}";
    }
    o << "],\"banks\":[";
    for (int i = 0; i < e->getCylinderBankCount(); ++i) {
        CylinderBank *b = e->getCylinderBank(i);
        CylinderHead *h = e->getHead(i);
        if (i) o << ",";
        const double chamberHeight = h->getCombustionChamberVolume() / b->boreSurfaceArea();
        o << "{\"x\":" << b->getX() << ",\"y\":" << b->getY() << ",\"angle\":" << b->getAngle()
          << ",\"dx\":" << b->getDx() << ",\"dy\":" << b->getDy()
          << ",\"bore\":" << b->getBore() << ",\"deck\":" << b->getDeckHeight()
          << ",\"displayDepth\":" << b->getDisplayDepth() << ",\"index\":" << b->getIndex()
          << ",\"chamberHeight\":" << chamberHeight << ",\"flip\":" << (h->getFlipDisplay() ? 1 : 0);
        Camshaft *cams[2] = { h->getIntakeCamshaft(), h->getExhaustCamshaft() };
        const char *names[2] = { "intakeCam", "exhaustCam" };
        for (int k = 0; k < 2; ++k) {
            Camshaft *cam = cams[k];
            o << ",\"" << names[k] << "\":{\"base\":" << cam->getBaseRadius() << ",\"lobes\":[";
            for (int l = 0; l < b->getCylinderCount(); ++l) o << (l ? "," : "") << cam->getLobeCenterline(l);
            o << "],\"profile\":[";
            const int N = 96;
            for (int s = 0; s < N; ++s) {
                const double th = 2 * constants::pi * s / N;
                o << (s ? "," : "") << cam->sampleLobe(th);
            }
            o << "]}";
        }
        o << "}";
    }
    o << "],\"cylinders\":[";
    for (int i = 0; i < e->getCylinderCount(); ++i) {
        Piston *p = e->getPiston(i);
        ConnectingRod *r = p->getRod();
        if (i) o << ",";
        int crankIndex = 0;
        for (int c = 0; c < e->getCrankshaftCount(); ++c) if (e->getCrankshaft(c) == r->getCrankshaft()) crankIndex = c;
        int masterIndex = -1;
        for (int c = 0; c < e->getCylinderCount(); ++c) if (e->getConnectingRod(c) == r->getMasterRod()) masterIndex = c;
        o << "{\"bank\":" << p->getCylinderBank()->getIndex() << ",\"bankCyl\":" << p->getCylinderIndex()
          << ",\"compressionHeight\":" << p->getCompressionHeight() << ",\"wristPin\":" << p->getWristPinLocation()
          << ",\"rodLength\":" << r->getLength() << ",\"bigEnd\":" << r->getBigEndLocal()
          << ",\"littleEnd\":" << r->getLittleEndLocal() << ",\"journal\":" << r->getJournal()
          << ",\"layer\":" << r->getLayer() << ",\"crank\":" << crankIndex << ",\"master\":" << masterIndex
          << ",\"slaveThrow\":" << r->getSlaveThrow() << ",\"rodJournals\":[";
        for (int j = 0; j < r->getRodJournalCount(); ++j) {
            double x, y;
            r->getRodJournalPositionLocal(j, &x, &y);
            o << (j ? "," : "") << x << "," << y;
        }
        o << "]}";
    }
    o << "]}";
    g_info = o.str();
}

} // namespace

API int es_load(const char *mainPath) {
    releaseAll();
    g_error.clear();

    es_script::Compiler::Output *out = es_script::Compiler::output();
    *out = es_script::Compiler::Output();

    es_script::Compiler compiler;
    compiler.initialize();
    const bool compiled = compiler.compile(mainPath);
    Engine *engine = nullptr;
    if (compiled) {
        const es_script::Compiler::Output output = compiler.execute();
        g_settings = output.applicationSettings;
        engine = output.engine;
        g_vehicle = output.vehicle;
        g_transmission = output.transmission;
    }
    else {
        std::ifstream log("error_log.log");
        std::stringstream ss;
        ss << log.rdbuf();
        g_error = ss.str();
        if (g_error.empty()) g_error = "Compilation failed";
    }
    compiler.destroy();

    if (engine == nullptr) {
        if (g_error.empty()) g_error = "Script did not produce an engine (is main() called?)";
        delete g_vehicle; g_vehicle = nullptr;
        delete g_transmission; g_transmission = nullptr;
        return 0;
    }

    if (g_vehicle == nullptr) {
        Vehicle::Parameters vehParams;
        vehParams.mass = units::mass(1597, units::kg);
        vehParams.diffRatio = 3.42;
        vehParams.tireRadius = units::distance(10, units::inch);
        vehParams.dragCoefficient = 0.25;
        vehParams.crossSectionArea = units::distance(6.0, units::foot) * units::distance(6.0, units::foot);
        vehParams.rollingResistance = 2000.0;
        g_vehicle = new Vehicle;
        g_vehicle->initialize(vehParams);
    }
    if (g_transmission == nullptr) {
        static const double gearRatios[] = { 2.97, 2.07, 1.43, 1.00, 0.84, 0.56 };
        Transmission::Parameters tParams;
        tParams.GearCount = 6;
        tParams.GearRatios = gearRatios;
        tParams.MaxClutchTorque = units::torque(1000.0, units::ft_lb);
        g_transmission = new Transmission;
        g_transmission->initialize(tParams);
    }

    g_engine = engine;
    g_sim = engine->createSimulator(g_vehicle, g_transmission);
    engine->calculateDisplacement();
    g_sim->setSimulationFrequency(engine->getSimulationFrequency());
    g_baseFreq = engine->getSimulationFrequency();

    Synthesizer::AudioParameters ap = g_sim->synthesizer().getAudioParameters();
    ap.inputSampleNoise = static_cast<float>(engine->getInitialJitter());
    ap.airNoise = static_cast<float>(engine->getInitialNoise());
    ap.dF_F_mix = static_cast<float>(engine->getInitialHighFrequencyGain());
    g_sim->synthesizer().setAudioParameters(ap);

    g_irs.clear();
    g_irVolumes.clear();
    for (int i = 0; i < engine->getExhaustSystemCount(); ++i) {
        ImpulseResponse *response = engine->getExhaustSystem(i)->getImpulseResponse();
        std::vector<int16_t> wav;
        if (!readWav(response->getFilename(), wav)) {
            g_error += "Could not read impulse response: " + response->getFilename() + "\n";
            wav.assign(1, 0);
        }
        g_irs.push_back(wav);
        g_irVolumes.push_back((float)response->getVolume());
        const unsigned n = (unsigned)std::min<size_t>(wav.size(), (size_t)g_irLimit);
        g_sim->synthesizer().initializeImpulseResponse(wav.data(), n, response->getVolume(), i);
    }

    g_targetSpeedSetting = g_speedSetting = 0.0;
    g_targetClutchPressure = g_clutchPressure = 1.0;
    g_dynoSpeed = 0.0;
    g_starter = false;

    buildInfo();
    return 1;
}

API const char *es_error() { return g_error.c_str(); }
API const char *es_info() { return g_info.c_str(); }

// ---- Controls ----
API void es_set_throttle(double t) { g_targetSpeedSetting = clamp01(t); }
API void es_set_starter(int on) { g_starter = on != 0; }
API void es_set_ignition(int on) { if (g_engine) g_engine->getIgnitionModule()->m_enabled = on != 0; }
API void es_set_gear(int gear) {
    if (!g_transmission) return;
    gear = (int)clampd(gear, -1, g_transmission->m_gearCount - 1);
    g_transmission->changeGear(gear);
}
API void es_set_clutch(double target, double rc) { g_targetClutchPressure = clamp01(target); g_clutchRC = rc; }
API void es_set_dyno(int enabled, int hold) {
    if (!g_sim) return;
    g_sim->m_dyno.m_enabled = enabled != 0;
    g_sim->m_dyno.m_hold = hold != 0;
}
API void es_set_dyno_speed(double s) { if (g_engine) g_dynoSpeed = clampd(s, g_engine->getDynoMinSpeed(), g_engine->getDynoMaxSpeed()); }
API void es_set_sim_speed(double s) { g_simSpeed = s; }
// Quality: scale the engine's own simulation frequency and set fluid sub-steps.

// Shorter impulse responses = cheaper convolution (shorter exhaust reverb tail).
API void es_set_ir_limit(int samples) {
    g_irLimit = (int)clampd(samples, 256, 10000);
    if (!g_sim) return;
    Synthesizer &syn = g_sim->synthesizer();
    for (size_t i = 0; i < g_irs.size(); ++i) {
        syn.m_filters[i].convolution.destroy();
        const unsigned n = (unsigned)std::min<size_t>(g_irs[i].size(), (size_t)g_irLimit);
        syn.initializeImpulseResponse(g_irs[i].data(), n, g_irVolumes[i], (int)i);
    }
}

API void es_set_quality(double freqScale, int fluidSteps) {
    if (!g_sim) return;
    // Floor: the rigid-body solver diverges for some engines below ~2.5-3.3 kHz (Hayabusa, LFA V10),
    // and keep at least 16 steps per crank revolution at redline.
    const double redlineRps = g_engine->getRedline() / (2 * constants::pi);
    const double floorFreq = std::min(g_baseFreq, std::max(3500.0, redlineRps * 16.0));
    g_sim->setSimulationFrequency((int)clampd(std::max(g_baseFreq * freqScale, floorFreq), 400, 400000));
    const double actualScale = g_sim->getSimulationFrequency() / g_baseFreq;
    if (PistonEngineSimulator *ps = dynamic_cast<PistonEngineSimulator *>(g_sim)) {
        ps->setFluidSimulationSteps((int)clampd(fluidSteps, 1, 32));
        // Upstream sizes the exhaust delay lines for 10000 steps/s at the engine's own
        // frequency. Rescale them so pulse timing (and the timbre) stays the same.
        for (int i = 0; i < g_engine->getCylinderCount(); ++i) {
            Piston *piston = g_engine->getChamber(i)->getPiston();
            CylinderHead *head = g_engine->getChamber(i)->getCylinderHead();
            ExhaustSystem *exhaust = head->getExhaustSystem(piston->getCylinderIndex());
            const double exhaustLength = head->getHeaderPrimaryLength(piston->getCylinderIndex()) + exhaust->getLength();
            const double delay = exhaustLength / (343.0 * units::m / units::sec);
            ps->m_delayFilters[i].m_history.destroy();
            ps->m_delayFilters[i].initialize(delay, 10000.0 * actualScale);
        }
    }
    // The synthesizer's input runs at the simulation frequency. Keep its anti-aliasing
    // cutoff (1.9 kHz upstream) below that rate's Nyquist so interpolation images don't
    // leak through at reduced frequencies.
    Synthesizer &syn = g_sim->synthesizer();
    const float cutoff = (actualScale > 0.999)
        ? 1900.0f
        : (float)std::min(1900.0, g_cutFactor * g_sim->getSimulationFrequency());
    for (int i = 0; i < syn.m_inputChannelCount; ++i) {
        syn.m_filters[i].antialiasing.setCutoffFrequency(cutoff, syn.m_audioSampleRate);
    }
}
API void es_set_sim_frequency(double f) { if (g_sim) g_sim->setSimulationFrequency((int)clampd(f, 400, 400000)); }
API void es_set_audio(double volume, double convolution, double hf, double lfNoise, double hfNoise) {
    if (!g_sim) return;
    Synthesizer::AudioParameters ap = g_sim->synthesizer().getAudioParameters();
    if (volume >= 0) ap.volume = (float)volume;
    if (convolution >= 0) ap.convolution = (float)convolution;
    if (hf >= 0) ap.dF_F_mix = (float)hf;
    if (lfNoise >= 0) ap.airNoise = (float)lfNoise;
    if (hfNoise >= 0) ap.inputSampleNoise = (float)hfNoise;
    g_sim->synthesizer().setAudioParameters(ap);
}

// ---- Simulation step ----
// Runs one frame of length dt seconds and returns the number of audio samples
// (44.1 kHz mono int16) made available through es_audio_ptr().
API int es_frame(double frameDt, double inputDt, int maxAudio) {
    if (!g_sim || !g_engine) return 0;
    frameDt = clampd(frameDt, 1 / 200.0, 1 / 30.0);
    const double dt = inputDt;

    // Throttle / speed control
    g_speedSetting = g_targetSpeedSetting * 0.5 + 0.5 * g_speedSetting;
    g_engine->setSpeedControl(g_speedSetting);

    // Dyno
    Simulator *s = g_sim;
    if (s->m_dyno.m_enabled) {
        if (!s->m_dyno.m_hold) {
            if (s->getFilteredDynoTorque() > units::torque(1.0, units::ft_lb)) g_dynoSpeed += units::rpm(500) * dt;
            else g_dynoSpeed *= (1 / (1 + dt));
            if (g_dynoSpeed > g_engine->getRedline()) {
                s->m_dyno.m_enabled = false;
                g_dynoSpeed = units::rpm(0);
            }
        }
    }
    else if (!s->m_dyno.m_hold) {
        g_dynoSpeed = units::rpm(0);
    }
    g_dynoSpeed = clampd(g_dynoSpeed, g_engine->getDynoMinSpeed(), g_engine->getDynoMaxSpeed());
    s->m_dyno.m_rotationSpeed = g_dynoSpeed;

    s->m_starterMotor.m_enabled = g_starter;

    // Clutch
    const double clutch_s = dt / (dt + g_clutchRC);
    g_clutchPressure = g_clutchPressure * (1 - clutch_s) + g_targetClutchPressure * clutch_s;
    g_transmission->setClutchPressure(g_clutchPressure);

    // Physics
    s->setSimulationSpeed(g_simSpeed);
    auto tp0 = std::chrono::steady_clock::now();
    s->startFrame(frameDt);
    while (s->simulateStep()) {}
    s->endFrame();
    auto tp1 = std::chrono::steady_clock::now();
    s->synthesizer().renderAudio();
    auto tp2 = std::chrono::steady_clock::now();
    g_physMs = g_physMs * 0.9 + 0.1 * std::chrono::duration<double, std::milli>(tp1 - tp0).count();
    g_audioMs = g_audioMs * 0.9 + 0.1 * std::chrono::duration<double, std::milli>(tp2 - tp1).count();

    if ((int)g_audio.size() < maxAudio) g_audio.resize(maxAudio);
    const int n = maxAudio > 0 ? s->readAudioOutput(maxAudio, g_audio.data()) : 0;

    // State snapshot
    std::vector<double> &st = g_state;
    const double ambientPressure = units::pressure(1.0, units::atm);
    const double ambientTemperature = units::celcius(25.0);
    const double rpm = std::fmax(g_engine->getRpm(), 0.0);
    const double theoreticalAirPerRev = 0.5 * (ambientPressure * g_engine->getDisplacement())
        / (constants::R * ambientTemperature);
    const double theoretical = theoreticalAirPerRev * rpm / 60.0;
    const double actual = g_engine->getIntakeFlowRate();
    Synthesizer::AudioParameters ap = s->synthesizer().getAudioParameters();

    st[0] = g_engine->getSpeed();  // rad/s
    st[1] = g_vehicle->getSpeed();
    st[2] = g_engine->getManifoldPressure();
    st[3] = actual;
    st[4] = std::abs(theoretical) < 1e-3 ? 0.0 : actual / theoretical;
    st[5] = s->getFilteredDynoTorque();
    st[6] = s->getDynoPower();
    st[7] = g_engine->getThrottle();
    st[8] = g_transmission->getGear();
    st[9] = g_transmission->m_gearCount;
    st[10] = g_clutchPressure;
    st[11] = s->m_starterMotor.m_enabled;
    st[12] = g_engine->getIgnitionModule()->m_enabled;
    st[13] = s->m_dyno.m_enabled;
    st[14] = s->m_dyno.m_hold;
    st[15] = g_dynoSpeed;
    st[16] = g_engine->getRedline();
    st[17] = s->getSimulationFrequency();
    st[18] = s->getSynthesizerInputLatency();
    st[19] = s->getSynthesizerInputLatencyTarget();
    st[20] = s->getFrameIterationCount();
    st[21] = s->getAverageProcessingTime();
    st[22] = g_engine->getIntakeAfr();
    st[23] = g_engine->getExhaustO2();
    st[24] = g_engine->getTotalVolumeFuelConsumed();
    st[25] = g_engine->getDisplacement();
    st[26] = g_speedSetting;
    st[27] = g_vehicle->getTravelledDistance();
    st[28] = n;
    st[29] = 0;
    st[30] = g_engine->getCylinderCount();
    st[31] = ap.volume;
    st[32] = ap.convolution;
    st[33] = ap.dF_F_mix;
    st[34] = ap.airNoise;
    st[35] = ap.inputSampleNoise;
    st[36] = s->synthesizer().getLevelerGain();
    st[37] = g_engine->getMaxDepth();
    st[38] = s->filteredEngineSpeed();
    st[39] = g_engine->getSpeedControl();
    st[40] = g_simSpeed;
    if (PistonEngineSimulator *ps = dynamic_cast<PistonEngineSimulator *>(s)) {
        st[41] = ps->getFluidSimulationSteps();
    }
    st[42] = g_engine->getOutputCrankshaft()->getCycleAngle();
    st[43] = g_physMs;
    st[44] = g_audioMs;

    // Geometry / per-cylinder data
    std::vector<double> &f = g_frame;
    f.clear();
    for (int i = 0; i < g_engine->getCrankshaftCount(); ++i) {
        Crankshaft *c = g_engine->getCrankshaft(i);
        f.push_back(c->m_body.p_x); f.push_back(c->m_body.p_y); f.push_back(c->m_body.theta);
    }
    for (int i = 0; i < g_engine->getCylinderCount(); ++i) {
        Piston *p = g_engine->getPiston(i);
        ConnectingRod *r = p->getRod();
        CombustionChamber *ch = g_engine->getChamber(i);
        CylinderHead *h = ch->getCylinderHead();
        const int bc = p->getCylinderIndex();
        f.push_back(p->m_body.p_x); f.push_back(p->m_body.p_y); f.push_back(p->m_body.theta);
        f.push_back(r->m_body.p_x); f.push_back(r->m_body.p_y); f.push_back(r->m_body.theta);
        f.push_back(ch->isLit() ? 1 : 0);
        f.push_back(ch->m_flameEvent.travel_x); f.push_back(ch->m_flameEvent.travel_y);
        f.push_back(ch->m_system.pressure()); f.push_back(ch->m_system.temperature());
        f.push_back(h->intakeValveLift(bc)); f.push_back(h->exhaustValveLift(bc));
        f.push_back(ch->getVolume());
    }
    for (int i = 0; i < g_engine->getCylinderBankCount(); ++i) {
        CylinderHead *h = g_engine->getHead(i);
        f.push_back(h->getIntakeCamshaft()->getAngle());
        f.push_back(h->getExhaustCamshaft()->getAngle());
    }
    return n;
}

API int16_t *es_audio_ptr() { return g_audio.data(); }
API double *es_state_ptr() { return g_state.data(); }
API double *es_frame_ptr() { return g_frame.data(); }
API int es_frame_len() { return (int)g_frame.size(); }

#ifndef __EMSCRIPTEN__
#include <chrono>
// Native smoke test: ./bridge-test <dir with es/ and assets/> <engine.mr>
int main(int argc, char **argv) {
    if (argc < 3) return 1;
    std::filesystem::current_path(std::string(argv[1]) + "/assets");
    std::ofstream m("web_main.mr");
    m << "import \"engine_sim.mr\"\nimport \"themes/default.mr\"\nimport \"" << argv[2] << "\"\nuse_default_theme()\nmain()\n";
    m.close();
    if (!es_load("web_main.mr")) { printf("ERR: %s\n", es_error()); return 1; }
    printf("info: %.300s...\n", es_info());
    if (getenv("CUT")) g_cutFactor = atof(getenv("CUT"));
    if (getenv("IR")) es_set_ir_limit(atoi(getenv("IR")));
    if (getenv("FS")) es_set_quality(atof(getenv("FS")), getenv("FLUID") ? atoi(getenv("FLUID")) : 8);
    es_set_starter(1);
    es_set_ignition(1);
    long total = 0;
    std::vector<int16_t> wavOut;
    auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < 600; ++i) {
        if (i == 120) es_set_starter(0);
        if (i == 300) es_set_throttle(1.0);
        const int got = es_frame(getenv("FDT") ? atof(getenv("FDT")) : 1 / 60.0, 1 / 60.0, 735);
        total += got;
        wavOut.insert(wavOut.end(), g_audio.begin(), g_audio.begin() + got);
        if (i % 60 == 0) printf("t=%.1fs rpm=%.0f thr=%.2f sc=%.2f steps=%.0f lat=%.3f audio=%ld\n", i / 60.0, g_state[0]*60/6.2832, g_state[7], g_state[26], g_state[20], g_state[18], total);
    }
    auto t1 = std::chrono::steady_clock::now();
    printf("phys %.2fms audio %.2fms per frame\n", g_physMs, g_audioMs);
    if (const char *wp = getenv("WAV")) {
        // Write 16-bit mono 44.1 kHz WAV for offline analysis.
        std::ofstream w(wp, std::ios::binary);
        const uint32_t dataBytes = (uint32_t)wavOut.size() * 2, rate = 44100, byteRate = rate * 2;
        const uint32_t riffSize = 36 + dataBytes, fmtSize = 16;
        const uint16_t pcm = 1, ch = 1, align = 2, bits = 16;
        w.write("RIFF", 4); w.write((const char *)&riffSize, 4); w.write("WAVEfmt ", 8);
        w.write((const char *)&fmtSize, 4); w.write((const char *)&pcm, 2); w.write((const char *)&ch, 2);
        w.write((const char *)&rate, 4); w.write((const char *)&byteRate, 4); w.write((const char *)&align, 2);
        w.write((const char *)&bits, 2); w.write("data", 4); w.write((const char *)&dataBytes, 4);
        w.write((const char *)wavOut.data(), dataBytes);
    }
    printf("10s simulated in %.2fs wall, audio samples=%ld\n", std::chrono::duration<double>(t1 - t0).count(), total);
    return 0;
}
#endif

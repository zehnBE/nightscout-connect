// Stub for trace-axios - replaces custom tracing module
function AxiosTracer(axiosInstance) {
    return {
        stop: function() {},
        reset: function() {},
        getGeneratedHar: function() {
            return { log: { entries: [] } };
        }
    };
}

module.exports = AxiosTracer;

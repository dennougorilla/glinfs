/**
 * Edge Change Ratio Scene Detector
 *
 * Detects scene changes by comparing edge information between consecutive frames.
 * Uses Sobel operator for edge detection and calculates edge change ratio (ECR).
 *
 * Algorithm:
 * 1. Convert frames to grayscale
 * 2. Apply Sobel edge detection
 * 3. Calculate entering edges and exiting edges between consecutive frames
 * 4. Compute Edge Change Ratio (ECR) = (entering + exiting) / max(current, previous)
 * 5. Detect scene change when ECR exceeds threshold
 * 6. Filter short scenes based on minimum duration
 *
 * Characteristics:
 * - More robust than pixel difference
 * - Less sensitive to camera motion and lighting changes
 * - Better at distinguishing scene changes from object movement
 * - Moderate computational cost
 *
 * References:
 * - Zabih, R., Miller, J., & Mai, K. (1999). "A feature-based algorithm for detecting
 *   and classifying scene breaks"
 *
 * @module scene-detection/algorithms/edge-change-detector
 */

/**
 * Convert RGBA imageData to grayscale values
 * @param {ImageData} imageData - Frame image data
 * @returns {Uint8Array} Grayscale pixel values
 */
function toGrayscale(imageData) {
  const { data, width, height } = imageData;
  const grayscale = new Uint8Array(width * height);

  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    // ITU-R BT.709 coefficients for perceptual luminance
    grayscale[j] = Math.round(
      0.2126 * data[i] +     // R
      0.7152 * data[i + 1] + // G
      0.0722 * data[i + 2]   // B
    );
  }

  return grayscale;
}

/**
 * Apply Sobel edge detection
 * @param {Uint8Array} grayscale - Grayscale pixel data
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {number} threshold - Edge threshold (0-255, default: 30)
 * @returns {Uint8Array} Binary edge map (1 = edge, 0 = no edge)
 */
function detectEdges(grayscale, width, height, threshold = 30) {
  const edges = new Uint8Array(width * height);

  // Sobel kernels
  const sobelX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const sobelY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

  // Skip border pixels (1 pixel margin)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let gx = 0;
      let gy = 0;

      // Apply Sobel kernel (3x3)
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const idx = (y + ky) * width + (x + kx);
          const pixel = grayscale[idx];
          const kernelIdx = (ky + 1) * 3 + (kx + 1);

          gx += pixel * sobelX[kernelIdx];
          gy += pixel * sobelY[kernelIdx];
        }
      }

      // Compute gradient magnitude
      const magnitude = Math.sqrt(gx * gx + gy * gy);

      // Binary edge detection
      const edgeIdx = y * width + x;
      edges[edgeIdx] = magnitude > threshold ? 1 : 0;
    }
  }

  return edges;
}

/**
 * Count total number of edge pixels
 * @param {Uint8Array} edges - Binary edge map
 * @returns {number} Number of edge pixels
 */
function countEdges(edges) {
  let count = 0;
  for (let i = 0; i < edges.length; i++) {
    count += edges[i];
  }
  return count;
}

/**
 * Calculate entering and exiting edges between two frames
 * @param {Uint8Array} edges1 - Previous frame edge map
 * @param {Uint8Array} edges2 - Current frame edge map
 * @returns {{entering: number, exiting: number}} Edge counts
 */
function calculateEdgeChanges(edges1, edges2) {
  let entering = 0; // New edges in current frame
  let exiting = 0;  // Edges removed from previous frame

  for (let i = 0; i < edges1.length; i++) {
    if (edges2[i] === 1 && edges1[i] === 0) {
      entering++;
    } else if (edges2[i] === 0 && edges1[i] === 1) {
      exiting++;
    }
  }

  return { entering, exiting };
}

/**
 * Calculate Edge Change Ratio (ECR)
 * @param {number} entering - Number of entering edges
 * @param {number} exiting - Number of exiting edges
 * @param {number} edgeCount1 - Edge count in previous frame
 * @param {number} edgeCount2 - Edge count in current frame
 * @returns {number} ECR value (0-2)
 */
function calculateECR(entering, exiting, edgeCount1, edgeCount2) {
  const maxEdges = Math.max(edgeCount1, edgeCount2);

  // Avoid division by zero
  if (maxEdges === 0) {
    return 0;
  }

  return (entering + exiting) / maxEdges;
}

/**
 * Detect scene breaks using edge change ratio
 * @param {Array} frames - Array of frame data with imageData
 * @param {Object} options - Detection options
 * @param {number} options.threshold - ECR threshold for scene detection (0-2, default: 0.5)
 * @param {number} options.edgeThreshold - Edge detection threshold (0-255, default: 30)
 * @param {number} options.minSceneDuration - Minimum frames per scene (default: 5)
 * @param {number} options.sampleInterval - Process every N frames (default: 1)
 * @param {Function} options.onProgress - Progress callback
 * @param {Function} options.checkCancellation - Cancellation check callback
 * @returns {Array<Object>} Array of detected scenes with metadata
 */
function detectScenes(frames, options = {}) {
  const {
    threshold = 0.5,
    edgeThreshold = 30,
    minSceneDuration = 5,
    sampleInterval = 1,
    onProgress = null,
    checkCancellation = null
  } = options;

  if (!frames || frames.length === 0) {
    return [];
  }

  const sceneBreaks = [0]; // First frame is always a scene start
  let prevEdges = null;
  let prevEdgeCount = 0;

  // Get dimensions from first frame
  const firstFrame = frames.find(f => f && f.imageData);
  if (!firstFrame) {
    return [];
  }
  const { width, height } = firstFrame.imageData;

  // Process frames and detect scene breaks
  for (let i = 0; i < frames.length; i += sampleInterval) {
    // Check cancellation every 10 frames
    if (checkCancellation && i % 10 === 0 && checkCancellation()) {
      throw new Error('Detection cancelled');
    }

    // Report progress
    if (onProgress && i % 10 === 0) {
      onProgress(i, frames.length);
    }

    const frame = frames[i];
    if (!frame || !frame.imageData) {
      continue;
    }

    // Convert to grayscale and detect edges
    const grayscale = toGrayscale(frame.imageData);
    const currentEdges = detectEdges(grayscale, width, height, edgeThreshold);
    const currentEdgeCount = countEdges(currentEdges);

    // Compare with previous frame
    if (prevEdges) {
      const { entering, exiting } = calculateEdgeChanges(prevEdges, currentEdges);
      const ecr = calculateECR(entering, exiting, prevEdgeCount, currentEdgeCount);

      // Detect scene break
      if (ecr > threshold) {
        sceneBreaks.push(i);
      }
    }

    prevEdges = currentEdges;
    prevEdgeCount = currentEdgeCount;
  }

  // Last frame marks end of final scene
  if (sceneBreaks[sceneBreaks.length - 1] !== frames.length - 1) {
    sceneBreaks.push(frames.length - 1);
  }

  // Convert break points to scenes
  const scenes = [];
  for (let i = 0; i < sceneBreaks.length - 1; i++) {
    const startFrame = sceneBreaks[i];
    const endFrame = sceneBreaks[i + 1];
    const duration = endFrame - startFrame;

    scenes.push({
      startFrame,
      endFrame,
      duration,
      timestamp: frames[startFrame]?.timestamp || 0,
      confidence: 1.0 // ECR doesn't provide confidence scores
    });
  }

  // Filter out short scenes
  const filteredScenes = filterShortScenes(scenes, minSceneDuration);

  // Report completion
  if (onProgress) {
    onProgress(frames.length, frames.length);
  }

  return filteredScenes;
}

/**
 * Filter and merge scenes shorter than minimum duration
 * @param {Array<Object>} scenes - Array of scenes
 * @param {number} minDuration - Minimum scene duration in frames
 * @returns {Array<Object>} Filtered scenes
 */
function filterShortScenes(scenes, minDuration) {
  if (scenes.length === 0) {
    return [];
  }

  const filtered = [];
  let currentScene = { ...scenes[0] };

  for (let i = 1; i < scenes.length; i++) {
    const scene = scenes[i];

    if (currentScene.duration < minDuration) {
      // Merge short scene with next scene
      currentScene.endFrame = scene.endFrame;
      currentScene.duration = currentScene.endFrame - currentScene.startFrame;
    } else {
      // Current scene is long enough, save it
      filtered.push(currentScene);
      currentScene = { ...scene };
    }
  }

  // Add the last scene
  filtered.push(currentScene);

  return filtered;
}

/**
 * Create an edge change ratio detector instance
 * @param {Object} config - Detector configuration
 * @returns {Object} Detector interface with detect method
 */
export function createEdgeChangeDetector(config = {}) {
  return {
    id: 'edge-change',
    name: 'Edge Change Ratio',
    description: 'Robust scene detection using edge information comparison',

    /**
     * Detect scenes in frames
     * @param {Array} frames - Array of frame data
     * @param {Object} options - Detection options
     * @returns {Array<Object>} Detected scenes
     */
    detect(frames, options = {}) {
      return detectScenes(frames, {
        ...config,
        ...options
      });
    },

    /**
     * Get default options for this detector
     * @returns {Object} Default options
     */
    getDefaultOptions() {
      return {
        threshold: 0.5,
        edgeThreshold: 30,
        minSceneDuration: 5,
        sampleInterval: 1
      };
    },

    /**
     * Get parameter info for UI configuration
     * @returns {Array<Object>} Parameter definitions
     */
    getParameters() {
      return [
        {
          name: 'threshold',
          label: 'ECR Threshold',
          type: 'number',
          min: 0.2,
          max: 1.0,
          step: 0.05,
          default: 0.5,
          description: 'Edge Change Ratio threshold (lower = more sensitive)'
        },
        {
          name: 'edgeThreshold',
          label: 'Edge Detection Threshold',
          type: 'number',
          min: 10,
          max: 100,
          step: 5,
          default: 30,
          description: 'Sobel gradient magnitude threshold (lower = more edges)'
        },
        {
          name: 'minSceneDuration',
          label: 'Minimum Scene Duration',
          type: 'number',
          min: 1,
          max: 30,
          step: 1,
          default: 5,
          description: 'Minimum number of frames per scene'
        },
        {
          name: 'sampleInterval',
          label: 'Sample Interval',
          type: 'number',
          min: 1,
          max: 10,
          step: 1,
          default: 1,
          description: 'Process every N frames (higher = faster but less accurate)'
        }
      ];
    }
  };
}

export default createEdgeChangeDetector;

// Canvas-based displays for lab.js
import { Component } from './core'
import { Sequence as BaseSequence, Loop, Parallel,
  prepareNested } from './flow'
import { Frame as BaseFrame } from './html'
import { reduce } from './util/tree'
import { makeRenderFunction, makeTransformationMatrix,
  transform } from './util/canvas'

// Global canvas functions used in all of the following components
// (multiple inheritance would come in handy here, but alas...)

// TODO: Rethink handling of the this binding
// in the following code, and refactor if necessary.
// (code is clean, but not necessarily as elegant
// as possible)

const addCanvasDefaults = function addCanvasDefaults(options) {
  // Setup canvas handling:
  // By default, the component does not
  // come bundled with a canvas. Instead,
  // the expectation is that it will receive
  // a canvas by the time it is prepared,
  // otherwise the component will take care of
  // creating its own canvas and appending
  // it to the dom at runtime.
  // Either way, a canvas is definitely present
  // after the component is prepared.
  return {
    canvas: null,
    ctxType: '2d',
    ctx: null,
    insertCanvasOnRun: false,
    // Move origin to canvas center
    translateOrigin: true,
    // Scale a viewport to the entire available space
    viewport: [800, 600],
    viewportScale: 'auto',
    viewportEdge: false,
    // Use high resolution if possible
    devicePixelScaling: null, // replaced by true if unspecified
    ...options,
  }
}

const prepareCanvas = function prepareCanvas() {
  // Initialize a canvas,
  // if this has not already been done
  if (this.options.canvas === null) {
    this.options.canvas = document.createElement('canvas')
    // Remember to add the canvas to the DOM later
    this.options.insertCanvasOnRun = true
  }

  // Setup resolution scaling
  if (this.options.devicePixelScaling === null) {
    this.options.devicePixelScaling = true
  }
}

const insertCanvas = function insertCanvas(clearElement=true) {
  // Add the canvas to the DOM if need be
  if (this.options.insertCanvasOnRun) {
    // Calculate scaling factor necessary for full resolution rendering
    const pixelRatio = this.options.devicePixelScaling
      ? window.devicePixelRatio
      : 1

    // Remove all other content within the HTML tag
    // (note that this could be sped up, as per
    // http://jsperf.com/innerhtml-vs-removechild
    // it seems sufficient for the moment, though)
    if (clearElement) {
      this.options.el.innerHTML = ''
    }

    // Adjust the canvas dimensions
    // to match those of the containing element
    this.options.canvas.width = this.options.el.clientWidth * pixelRatio
    this.options.canvas.height = this.options.el.clientHeight * pixelRatio

    // Set the canvas element dimensions
    this.options.canvas.style.width = `${ this.options.el.clientWidth }px`
    this.options.canvas.style.height = `${ this.options.el.clientHeight }px`

    // Append the canvas to the DOM
    if (clearElement) {
      this.options.el.appendChild(this.options.canvas)
    }
  }
}

// Canvas-based components -----------------------------------------------------

export class Screen extends Component {
  constructor(options={}) {
    super({
      content: null,
      renderFunction: null,
      clearCanvas: true,
      ...addCanvasDefaults(options),
    })

    // Provide an attribute for tracking
    // redraw requests
    this.internals.frameRequest = null

    // Bind render method
    this.render = this.render.bind(this)
  }

  onPrepare() {
    prepareCanvas.apply(this)

    // Generate generic render function,
    // unless a render function has been defined manually
    // TODO: This should probably not be the default.
    //   Instead, in a future release, there should probably
    //   be a BaseScreen class that accepts a manually defined
    //   render function. Alternatively, a more advanced class
    //   should be created that includes the generic render
    //   function
    if (this.options.renderFunction === null) {
      this.options.renderFunction = makeRenderFunction(this.options.content)
    }
  }

  onRun() {
    // Add canvas to the dom, if necessary
    insertCanvas.apply(this)

    // Extract the requested context for the canvas
    this.options.ctx = this.options.canvas.getContext(
      this.options.ctxType,
    )

    // Coordinate system translation and scaling -------------------------------

    // Save current transformation state
    this.options.ctx.save()

    const tm = makeTransformationMatrix(
      [this.options.canvas.width, this.options.canvas.height],
      this.options.viewport,
      {
        translateOrigin: this.options.translateOrigin,
        viewportScale: this.options.viewportScale,
        devicePixelScaling: this.options.devicePixelScaling,
        canvasClientRect: this.options.canvas.getBoundingClientRect(),
      },
    )
    this.internals.transformationMatrix = tm[0]
    this.internals.viewportTransformationMatrix = tm[1]

    this.options.ctx.setTransform(...this.internals.transformationMatrix)
  }

  onRender(timestamp) {
    // Clear canvas if requested
    // TODO: This should check if the canvas is fresh,
    // and not run if it isn't necessary
    if (this.options.clearCanvas) {
      this.clear()
    }

    // Draw viewport for debugging purposes
    if (this.options.viewportEdge) {
      this.options.ctx.save()
      this.options.ctx.strokeStyle = 'rgb(229, 229, 229)'

      this.options.ctx.strokeRect(
        this.options.translateOrigin ? -this.options.viewport[0] / 2 : 0,
        this.options.translateOrigin ? -this.options.viewport[1] / 2 : 0,
        this.options.viewport[0],
        this.options.viewport[1],
      )

      this.options.ctx.restore()
    }

    return this.options.renderFunction.call(
      this, // context
      timestamp, // arguments ...
      this.options.canvas,
      this.options.ctx,
      this,
    )
  }

  onEnd() {
    // Undo any previously applied tranformations
    this.options.ctx.restore()
  }

  clear() {
    this.options.ctx.save()
    this.options.ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.options.ctx.clearRect(
      0, 0, this.options.canvas.width, this.options.canvas.height,
    )
    this.options.ctx.restore()
  }

  transform(coordinates) {
    if (!this.internals.transformationMatrix) {
      throw new Error('No transformation matrix set')
    }

    return transform(this.internals.transformationMatrix, coordinates)
  }
}

Screen.metadata = {
  module: ['canvas'],
  nestedComponents: [],
  parsableOptions: {
    content: {
      type: 'array',
      content: {
        type: 'object',
        content: {
          text: {},
          fill: {},
          stroke: {},
          left: { type: 'number' },
          top: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          angle: { type: 'number' },
        },
      },
    },
  },
}

// Canvas-based sequence of components
// drawing on the same canvas
export class Sequence extends BaseSequence {
  constructor(options={}) {
    super(
      addCanvasDefaults(options),
    )

    // Push canvas to nested components
    if (!this.options.handMeDowns.includes('canvas')) {
      this.options.handMeDowns.push('canvas', 'devicePixelScaling')
    }
  }

  onPrepare() {
    // Prepare canvas
    prepareCanvas.apply(this)

    // Check that all nested components
    // use the Canvas
    const isCanvasBased = e =>
      e instanceof Screen ||
      e instanceof Sequence

    if (!this.options.content.every(isCanvasBased)) {
      throw new Error(
        'Content component not a canvas.Screen or canvas.Sequence',
      )
    }

    // Prepare sequence as usual
    return super.onPrepare()
  }

  onRun(frameTimestamp) {
    // Insert canvas into DOM,
    // if not present already
    insertCanvas.apply(this)

    // Run sequence as usual
    return super.onRun(frameTimestamp)
  }
}

Sequence.metadata = {
  module: ['canvas'],
  nestedComponents: ['content'],
}

export class Frame extends BaseFrame {
  constructor(options={}) {
    super(addCanvasDefaults({
      context: '<canvas></canvas>',
      ...options,
    }))

    // Push canvas to nested components
    if (!this.options.handMeDowns.includes('canvas')) {
      this.options.handMeDowns.push('canvas', 'devicePixelScaling')
    }
  }

  async onPrepare() {
    // Check that all nested components
    // are either flow components or
    // that they use the canvas
    const isFlowOrCanvasBased = (acc, c) =>
      acc && (
        c === this ||
        c instanceof Screen ||
        c instanceof Sequence ||
        c instanceof BaseSequence ||
        c instanceof Loop ||
        c instanceof Parallel
      )

    const canvasBasedSubtree = reduce(this, isFlowOrCanvasBased, true)
    if (!canvasBasedSubtree) {
      throw new Error(
        'CanvasFrame may only contain flow or canvas-based components',
      )
    }

    // TODO: This is largely lifted (with some adaptations)
    // from the html.Frame implementation. It would be great
    // to reduce duplication slightly. (the differences
    // are the allocation of the el option, and the
    // extraction of the canvas from the parsed context)

    // Parse context HTML
    const parser = new DOMParser()
    this.internals.parsedContext = parser.parseFromString(
      this.options.context, 'text/html',
    )

    // Extract canvas
    this.options.canvas = this.internals
      .parsedContext.querySelector('canvas')

    if (!this.options.canvas) {
      throw new Error('No canvas found in context')
    }

    // Set nested component el to the parent
    // element of the canvas, or the current el
    // (if the canvas is at the uppermost level
    // in the context HTML structure, and
    // therefore its parent in the virtual DOM
    // is a <body> element)
    this.options.content.options.el =
      this.options.canvas.parentElement === null ||
      this.options.canvas.parentElement.tagName === 'BODY'
        ? this.options.el
        : this.options.canvas.parentElement

    // Couple the run cycle of the frame to its content
    this.internals.contentEndHandler = () => this.end()
    this.options.content.on(
      'after:end',
      this.internals.contentEndHandler,
    )

    prepareCanvas.apply(this)
    this.options.insertCanvasOnRun = true

    // Prepare content
    await prepareNested([this.options.content], this)
  }

  // TODO: This should probably be moved to onRun,
  // and call super.onRun()
  async onBeforeRun() {
    insertCanvas.apply(this, [false])
  }
}

Frame.metadata = {
  module: ['canvas'],
  nestedComponents: ['content'],
}

require('dotenv').config()
const puppeteer = require('puppeteer')
const spawn = require('child_process').spawn
const tkt = require('tkt')
const fs = require('fs')
const path = require('path')
const axios = require('axios')
const amqp = require('amqplib/callback_api')
const FormData = require('form-data')
console.log('RABBIT_HOST', process.env.RABBIT_HOST)
console.log(
  'WORKERS COUNT ',
  process.env.WORKERS || require('os').cpus().length,
)
function createRendererFactory(
  url,
  {
    scale = 1,
    alpha = false,
    launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'],
  } = {},
) {
  const DATA_URL_PREFIX = 'data:image/png;base64,'
  return function createRenderer({ name = 'Worker' } = {}) {
    const promise = (async () => {
      const browser = await puppeteer.launch({
        args: launchArgs,
      })
      const page = await browser.newPage()
      page.on('console', (msg) => console.log('PAGE LOG:', msg.text()))
      page.on('pageerror', (msg) => console.log('PAGE ERROR:', msg))
      await page.goto(url, { waitUntil: 'load' })
      const info = await page.evaluate(`(async () => {
        let deadline = Date.now() + 10000
        while (Date.now() < deadline) {
          if (typeof getInfo === 'function') {
            break
          }
          await new Promise(r => setTimeout(r, 1000))
        }
        const info = await getInfo()
        if (!info.width || !info.height) {
          Object.assign(info, {
            width: document.querySelector('#scene').offsetWidth,
            height: document.querySelector('#scene').offsetHeight,
          })
        }
        return info
      })()`)
      await page.setViewport({
        width: info.width,
        height: info.height,
        deviceScaleFactor: scale,
      })
      return { browser, page, info }
    })()
    let rendering = false
    return {
      async getInfo() {
        return (await promise).info
      },
      async render(i) {
        if (rendering) {
          throw new Error('render() may not be called concurrently!')
        }
        rendering = true
        try {
          const marks = [Date.now()]
          const { page, info } = await promise
          marks.push(Date.now())
          const result = await page.evaluate(`seekToFrame(${i})`)
          marks.push(Date.now())
          const buffer =
            typeof result === 'string' && result.startsWith(DATA_URL_PREFIX)
              ? Buffer.from(result.substr(DATA_URL_PREFIX.length), 'base64')
              : await page.screenshot({
                  clip: { x: 0, y: 0, width: info.width, height: info.height },
                  omitBackground: alpha,
                })
          marks.push(Date.now())
          // console.log(
          //   name,
          //   `render(${i}) finished`,
          //   `timing=${marks
          //     .map((v, i, a) => (i === 0 ? null : v - a[i - 1]))
          //     .slice(1)}`,
          // )
          return buffer
        } finally {
          rendering = false
        }
      },
      async end() {
        const { browser } = await promise
        browser.close()
      },
    }
  }
}

function createParallelRender(max, rendererFactory) {
  const available = []
  const working = new Set()
  let nextWorkerId = 1
  let waiting = null
  function obtainWorker() {
    if (available.length + working.size < max) {
      const id = nextWorkerId++
      const worker = { id, renderer: rendererFactory(`Worker ${id}`) }
      available.push(worker)
      console.log('Spawn worker %d', worker.id)
      if (waiting) waiting.nudge()
    }
    if (available.length > 0) {
      const worker = available.shift()
      working.add(worker)
      return worker
    }
    return null
  }
  const work = async (fn, taskDescription) => {
    for (;;) {
      const worker = obtainWorker()
      if (!worker) {
        if (!waiting) {
          let nudge
          const promise = new Promise((resolve) => {
            nudge = () => {
              waiting = null
              resolve()
            }
          })
          waiting = { promise, nudge }
        }
        await waiting.promise
        continue
      }
      try {
        // console.log('Worker %d: %s', worker.id, taskDescription)
        const result = await fn(worker.renderer)
        available.push(worker)
        if (waiting) waiting.nudge()
        return result
      } catch (e) {
        worker.renderer.end()
        throw e
      } finally {
        working.delete(worker)
      }
    }
  }
  return {
    async getInfo() {
      return work((r) => r.getInfo(), 'getInfo')
    },
    async render(i) {
      return work((r) => r.render(i), `render(${i})`)
    },
    async end() {
      return Promise.all(
        [...available, ...working].map((r) => r.renderer.end()),
      )
    },
  }
}

function ffmpegOutput(fps, outPath, { alpha }) {
  const ffmpeg = spawn('/usr/bin/ffmpeg', [
    ...['-f', 'image2pipe'],
    ...['-framerate', `${fps}`],
    ...['-i', '-'],
    ...(alpha
      ? [
          // https://stackoverflow.com/a/12951156/559913
          ...['-c:v', 'qtrle'],

          // https://unix.stackexchange.com/a/111897
          // ...['-c:v', 'prores_ks'],
          // ...['-pix_fmt', 'yuva444p10le'],
          // ...['-profile:v', '4444'],
          // https://www.ffmpeg.org/ffmpeg-codecs.html#Speed-considerations
          // ...['-qscale', '4']
        ]
      : [
          ...['-c:v', 'libx264'],
          ...['-crf', '16'],
          ...['-preset', 'ultrafast'],
          // https://trac.ffmpeg.org/wiki/Encode/H.264#Encodingfordumbplayers
          ...['-pix_fmt', 'yuv420p'],
        ]),
    '-y',
    outPath,
  ])
  ffmpeg.stderr.pipe(process.stderr)
  ffmpeg.stdout.pipe(process.stdout)
  return {
    writePNGFrame(buffer, _frameNumber) {
      ffmpeg.stdin.write(buffer)
    },
    end() {
      ffmpeg.stdin.end()
    },
    closed() {
      return new Promise(function (resolve, reject) {
        ffmpeg.once('close', function (code) {
          if (code == 0) {
            resolve(code)
          } else {
            reject(code)
          }
        })
      })
    },
  }
}

async function runRender(args) {
  const renderer = createParallelRender(
    args.parallelism,
    createRendererFactory(args.url, {
      scale: args.scale,
      alpha: args.alpha,
    }),
  )
  const info = await renderer.getInfo()
  console.log('Movie info:', info)

  output = ffmpegOutput(info.fps, args.video, {
    alpha: args.alpha,
  })

  const promises = []
  const start = args.start || 0
  const end = args.end || info.numberOfFrames
  for (let i = start; i < end; i++) {
    promises.push({ promise: renderer.render(i), frame: i })
  }
  for (let i = 0; i < promises.length; i++) {
    // console.log('Render frame %d %d/%d', promises[i].frame, i, promises.length)
    const buffer = await promises[i].promise
    output.writePNGFrame(buffer, promises[i].frame)
  }
  output.end()
  renderer.end()
  await output.closed()
}

async function sendVideo(options) {
  const form_data = new FormData()
  let videoFile = fs.createReadStream(options.videoPath)
  form_data.append('video[file]', videoFile, 'video.mp4')
  const request_config = {
    method: 'put',
    url: options.url,
    headers: {
      'Content-Type': 'multipart/form-data',
    },
    data: form_data,
  }
  return axios(request_config)
}

tkt
  .cli()
  .command(
    '$0',
    'Renders a video',
    {
      url: {
        description: 'The URL to render',
        type: 'string',
        default: `file://${__dirname}/examples/gsap-hello-world.html?render`,
      },
      video: {
        description:
          'The path to video file to render. Without `--alpha` this MUST be .mp4, and with `--alpha` this MUST be .mov',
        type: 'string',
        default: 'video.mp4',
      },
      parallelism: {
        description:
          'How many headless Chrome processes to use to render in parallel',
        type: 'number',
        default: process.env.WORKERS || require('os').cpus().length,
      },
      start: {
        description: 'Frame number to start rendering',
        type: 'number',
        default: 0,
      },
      end: {
        description:
          'Frame number to end rendering (that frame number will not be rendered)',
        type: 'number',
      },
      alpha: {
        description:
          'Renders a image/video with alpha transparency. For video, the file extension MUST be .mov',
        type: 'boolean',
      },
      scale: {
        description: 'Device scale factor',
        type: 'number',
        default: 1,
      },
    },
    async function main(args) {
      runRender(args)
    },
  )
  .command('server', 'Starts a rendering server', {}, async () => {
    amqp.connect(process.env.RABBIT_HOST, function (error0, connection) {
      if (error0) {
        throw error0
      }
      connection.createChannel(function (error1, channel) {
        if (error1) {
          throw error1
        }
        var queue = 'video_processing'

        channel.assertQueue(queue, {
          durable: true,
        })
        channel.prefetch(1)
        console.log(
          ' [*] Waiting for messages in %s. To exit press CTRL+C',
          queue,
        )
        channel.consume(
          queue,
          async function (msg) {
            console.log(' [x] Received ', msg.content.toString())
            try {
              let payload
              payload = await axios.get(msg.content.toString())
              console.log(payload.data)
              let renderOptions = {
                url: payload.data.html,
                video: 'video.mp4',
                parallelism: process.env.WORKERS || require('os').cpus().length,
                start: 0,
                end: null,
                alpha: null,
                scale: 1,
              }
              try {
                fs.unlinkSync(renderOptions.video)
              } catch (err) {}
              await runRender(renderOptions)
              await sendVideo({
                url: payload.data.update_link,
                videoPath: renderOptions.video,
              })
              console.log(' [x] Done')
              channel.ack(msg)
            } catch (error) {
              console.error(
                '[x] Error',
                msg.content.toString(),
                error.message,
              )
              channel.nack(msg)
            }
          },
          {
            noAck: false,
          },
        )
      })
    })
    return new Promise(() => {})
  })
  .parse()

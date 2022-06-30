require('dotenv').config()

const isDevEnvironment = process.env.environment === 'dev' || false

const http = require('http')

const express = require('express')
const rateLimit = require('express-rate-limit')

const { fetch } = require('cross-fetch')
const AWS = require('aws-sdk')
const sharp = require('sharp')

const isAbsoluteUrlRegexp = new RegExp('^(?:[a-z]+:)?//', 'i')

function checkOrigin(origin) {
  return (
    typeof origin === 'string'
    && (
      origin === 'volt.link'
      || origin.endsWith('://volt.link')

      // allow from subdomains
      || origin.endsWith('.volt.link')

      // allow for localhost
      || origin.endsWith('localhost:3000')
      || origin.endsWith('localhost:4000')
      || origin.endsWith('0.0.0.0:3000')
      || origin.endsWith('0.0.0.0:4000')
      || origin.endsWith('localhost:19006')
    )
  )
}

const app = express()

// set up rate limiter: maximum of 100 requests per minute
app.use(rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 1000, // Limit each IP to 1000 requests per `window` (here, per 1 minute)
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
})) // apply rate limiter to all requests

app.use(express.json())

app.use(function (req, res, next) {
  // const origin = req.get('origin')
  const origin = req.header('Origin')
  if (checkOrigin(origin)) {
    req.is_subdomain = true
    req.origin = origin
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', true)
  } else {
    req.is_subdomain = false
  }

  next()
})

app.options("/*", function (req, res, next) {
  // correctly response for cors
  if (req.is_subdomain) {
    res.setHeader('Access-Control-Allow-Origin', req.origin)
    res.setHeader('Access-Control-Allow-Credentials', true)
    res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With')
    res.sendStatus(200)
  } else {
    res.sendStatus(403)
  }
})

app.get('/', async function (req, res, next) {
  res.send('')
})


async function getBlockById(id, headers = {}) {
  return new Promise((resolve, reject) => {
    fetch((
      isDevEnvironment
        ? 'http://0.0.0.0:4004/graphql/v1/'
        : 'https://api.volt.link/graphql/v1/'
    ), {
      method: 'POST',
      body: JSON.stringify({
        query: `query ($_id: ObjectID!) {
          block (_id: $_id) {
            _id
            type
            properties
          }
        }`,
        variables: {
          _id: id,
        }
      }),
      headers: {
        ...headers,
        'content-type': 'application/json',
      }
    })
      .then(async data => {
        data = await data.json()
        if (data && data.errors) {
          reject(data.errors.map(e => e.message).join('\n\n'))
        } else if (
          data
          && data.data
          && data.data.block
        ) {
          resolve(data.data.block)
        } else {
          resolve(null)
        }
      })
      .catch(error => {
        console.error(error)
        resolve(null)
      })
  })
}

app.get('/download_file', async (req, res) => {
  const { fileTypeStream } = await import('file-type')

  const headers = {
    cookie: req.headers.cookie, // for authentication
    'user-agent': req.headers['user-agent'], // for analytics
    referer: req.headers.referer, // for analytics
  }

  const fileId = req.query.id || null
  if (typeof fileId === 'string' && fileId.length > 0) {
    try {
      const block = await getBlockById(fileId, headers)

      if (typeof block === 'object' && block !== null) {

        let filename = block?.properties?.name || ''
        let bucketName = block?.properties?.aws_s3?.Bucket
        let keyName = block?.properties?.aws_s3?.Key

        if (
          typeof bucketName === 'string' && bucketName.length > 0 &&
          typeof keyName === 'string' && keyName.length > 0
        ) {

          const s3 = new AWS.S3({
            endpoint: 'https://s3.eu-central-1.amazonaws.com/',
            accessKeyId: process.env.s3_access_key_id,
            secretAccessKey: process.env.s3_secret_access_key,
            accessSecretKey: process.env.s3_secret_access_key,
            region: 'eu-central-1',
            sslEnabled: false,
            s3ForcePathStyle: true,
          })
          const readableS3Stream = s3.getObject({
            Bucket: bucketName,
            Key: keyName
          })
            .createReadStream()

          readableS3Stream.on('error', error => {
            console.error('error whilegetting s3-readstream', error)
          })

          const readableS3StreamWithFiletype = await fileTypeStream(readableS3Stream)
          let mime = readableS3StreamWithFiletype?.fileType?.mime || ''

          // const readableS3StreamWithFiletype = readableS3Stream
          // let mime = 'image/png'

          if (!mime) {
            if (filename.endsWith('.svg')) {
              mime = 'image/svg'
            } else {
              mime = ''
            }
          }

          if ([
            // sharp support: JPEG, PNG, WebP, AVIF, GIF, SVG, TIFF (date checked: 2022-02-18)
            'image/jpeg',
            'image/png',
            'image/webp',
            'image/gif', // TODO: sharp does not support animated gifs. Replace with this: https://stackoverflow.com/questions/47138754/nodejs-animated-gif-resizing
            'image/tiff',
          ].includes(mime)) {
            // resize the image to maxwidth and maxheight
            let maxWidth = parseInt(req.query.w) || null
            let maxHeight = parseInt(req.query.h) || null

            let format = req.query.f
            if (!['jpeg', 'png', 'webp'].includes(format)) {
              format = 'jpeg'
            }

            let formatOptions = {}
            if (format === 'webp') {
              mime = 'image/webp'
              formatOptions = {
                quality: 80,
              }
            }
            if (format === 'jpeg') {
              mime = 'image/jpeg'
              formatOptions = {
                quality: 80,
                alphaQuality: 80,
              }
            }
            if (format === 'png') {
              mime = 'image/png'
              formatOptions = {
                quality: 80,
                progressive: true,
              }
            }

            let sharpResizer = null
            
            if (maxWidth !== null || maxHeight !== null) {
              if (maxWidth === null) {
                maxWidth = maxHeight
              } else if (maxHeight === null) {
                maxHeight = maxWidth
              }

              sharpResizer = sharp()
                .resize(maxWidth, maxHeight, {
                  kernel: sharp.kernel.lanczos3,
                  fit: 'outside',
                  withoutEnlargement: true,
                  fastShrinkOnLoad: true,
                })
                .toFormat(format, formatOptions)
            } else {
              sharpResizer = sharp()
                .toFormat(format, formatOptions)
            }

            res
              .set('Content-Disposition', `filename="${filename}"`)
              .type(mime) // Do this in both if and else, cause "if" changes "mime".
              .status(200)

            readableS3StreamWithFiletype
              .pipe(sharpResizer)
              .pipe(res)
          } else {
            res
              .set('Content-Disposition', `filename="${filename}"`)
              .type(mime) // Do this in both if and else, cause "if" changes "mime".
              .status(200)

            readableS3StreamWithFiletype
              .pipe(res)
          }
        } else {
          res.status(500).send('invalid block properties')
        }
      } else {
        res.status(400).send('Not found.')
      }
    } catch (error) {
      console.error(error)
      res.status(400).send(error)
    }

    /*
    fetch(url)
      .then(async response => {
        let responseBuffer = await response.buffer()

        const filename = url.split('/').pop() || ''


        //     const stream = fs.createReadStream('Unicorn.mp4');
        //     console.log(await fileTypeFromStream(stream));
        // // => {ext: 'mp4', mime: 'video/mp4'}

        let { mime } = await fileTypeFromBuffer(responseBuffer) || {}

        if (!mime) {
          if (filename.endsWith('.svg')) {
            mime = 'image/svg'
          } else {
            mime = ''
          }
        }

        if ([
          // sharp support: JPEG, PNG, WebP, AVIF, GIF, SVG, TIFF (date checked: 2022-02-18)
          'image/jpeg',
          'image/png',
          'image/webp',
          'image/gif', // TODO: sharp does not support animated gifs. Replace with this: https://stackoverflow.com/questions/47138754/nodejs-animated-gif-resizing
          'image/tiff',
        ].includes(mime)) {
          // resize the image in responseBuffer to maxwidth
          const maxWidth = parseInt(req.query.w) || 2000
          const maxHeight = parseInt(req.query.h) || 2000
          let format = req.query.f
          if (!['jpeg', 'png', 'webp'].includes(format)) {
            format = 'jpeg'
          }

          if (format === 'webp') {
            mime = 'image/webp'
          }
          if (format === 'jpeg') {
            mime = 'image/jpeg'
          }
          if (format === 'png') {
            mime = 'image/png'
          }

          responseBuffer = await sharp(responseBuffer)
            .resize(maxWidth, maxHeight, {
              kernel: sharp.kernel.lanczos3,
              fit: 'outside',
              withoutEnlargement: true,
              fastShrinkOnLoad: true,
            })
            .toFormat(format)
            .toBuffer()
        }

        res
          .set('Content-Disposition', `filename="${filename}"`)
          .type(mime)
          .status(200)
          .send(responseBuffer)
      })
      .catch(error => {
        console.error(error)
        res.status(404).send(error)
      })
    */
  } else {
    res.status(404).send('Error: Missing file id.')
  }
})

app.get('/download_url', async (req, res) => {
  const { fileTypeFromBuffer } = await import('file-type')

  const url = req.query.url || null

  if (typeof url === 'string' && url.length > 0 && isAbsoluteUrlRegexp.test(url)) {
    fetch(url)
      .then(async response => {
        let responseBuffer = await response.buffer()

        const filename = url.split('/').pop() || ''

        let { mime } = await fileTypeFromBuffer(responseBuffer) || {}

        if (!mime) {
          if (filename.endsWith('.svg')) {
            mime = 'image/svg'
          } else {
            mime = ''
          }
        }

        if ([
          // sharp support: JPEG, PNG, WebP, AVIF, GIF, SVG, TIFF (date checked: 2022-02-18)
          'image/jpeg',
          'image/png',
          'image/webp',
          'image/gif', // TODO: sharp does not support animated gifs. Replace with this: https://stackoverflow.com/questions/47138754/nodejs-animated-gif-resizing
          'image/tiff',
        ].includes(mime)) {
          // resize the image in responseBuffer to maxwidth
          const maxWidth = parseInt(req.query.w) || 2000
          const maxHeight = parseInt(req.query.h) || 2000
          let format = req.query.f
          if (!['jpeg', 'png', 'webp'].includes(format)) {
            format = 'jpeg'
          }

          let formatOptions = {}
          if (format === 'webp') {
            mime = 'image/webp'
            formatOptions = {
              quality: 80,
            }
          }
          if (format === 'jpeg') {
            mime = 'image/jpeg'
            formatOptions = {
              quality: 80,
              alphaQuality: 80,
            }
          }
          if (format === 'png') {
            mime = 'image/png'
            formatOptions = {
              quality: 80,
              progressive: true,
            }
          }

          responseBuffer = await sharp(responseBuffer)
            .resize(maxWidth, maxHeight, {
              kernel: sharp.kernel.lanczos3,
              fit: 'outside',
              withoutEnlargement: true,
              fastShrinkOnLoad: true,
            })
            .toFormat(format, formatOptions)
            .toBuffer()
        }

        res
          .set('Content-Disposition', `filename="${filename}"`)
          .type(mime)
          .status(200)
          .send(responseBuffer)
      })
      .catch(error => {
        console.error(error)
        res.status(404).send(error)
      })
  } else {
    res.status(404).send('')
  }
})

const port = 4006
const host = '0.0.0.0' // Uberspace wants 0.0.0.0
http.createServer(app).listen({ port, host }, () =>
  console.info(`
    🚀 Server ready
    For uberspace: http://${host}:${port}/
    For local development: http://localhost:${port}/
  `)
)


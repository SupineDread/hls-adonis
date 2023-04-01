// import type { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
import type { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
import Application from '@ioc:Adonis/Core/Application'
import Drive from '@ioc:Adonis/Core/Drive'
import Logger from '@ioc:Adonis/Core/Logger'

import * as fs from 'fs'
import * as path from 'path'
import ffmpeg from '@ffmpeg-installer/ffmpeg'
const ffprobe = require('@ffprobe-installer/ffprobe')

import Video from 'App/Models/Video'

import Transcoder from 'hls-transcoder'

export default class VideosController {
  public async index({ view }: HttpContextContract) {
    const videos = await Video.all()

    return view.render('videos/index.edge', { videos })
  }

  public async create({ view }: HttpContextContract) {
    return view.render('videos/create.edge')
  }

  public async show({ params, view }: HttpContextContract) {
    const video = await Video.findByOrFail('id', params.id)
    // const cloudfront = { url: 'YOUR-CLOUDFRONT-URL-HERE' } // <- Put your cloudfront url here DON'T include https://

    // return view.render('videos/show.edge', { video, cloudfront })
    return view.render('videos/show.edge', { video })
  }

  public async store({ request, response }: HttpContextContract) {
    const videoFile = request.file('videoFile')
    const name = request.input('name')

    var video = await Video.create({
      name: name,
    })
    // Since id is generated at the database level, we can't use video.id before video is created
    video.originalVideo = `uploads/uploads/${video.id}/original.mp4`

    await videoFile?.moveToDisk(
      `uploads/uploads/${video.id}`,
      {
        name: `original.mp4`,
      },
      'local'
    )

    await this.transcodeVideo(video)

    response.redirect().toPath('/videos')
  }

  private async transcodeVideo(video: Video): Promise<void> {
    const local = Drive.use('local')
    const s3 = Drive.use('local')

    // Get FileBuffer from S3
    const videoFileBuffer = await s3.get(video.originalVideo)
    // Save S3 file to local tmp dir
    await local.put(`uploads/transcode/${video.id}/original.mp4`, videoFileBuffer)
    // Get reference to tmp file
    const tmpVideoPath = Application.tmpPath(`uploads/transcode/${video.id}/original.mp4`)

    const transcoder = new Transcoder(
      tmpVideoPath,
      Application.tmpPath(`uploads/transcode/${video.id}`),
      {
        ffmpegPath: ffmpeg.path,
        ffprobePath: ffprobe.path,
      }
    )

    // Log transcoder progress status
    transcoder.on('progress', (progress) => {
      Logger.info(progress)
    })

    // Run the transcoding
    await transcoder.transcode()

    // After transcoding, upload files to S3
    let files
    try {
      files = fs.readdirSync(Application.tmpPath(`uploads/transcode/${video.id}/`))
    } catch (err) {
      Logger.error(err)
    }

    await files.forEach(async (file) => {
      const extname = path.extname(file)
      if (extname === '.ts' || extname === '.m3u8') {
        const fileStream = await local.get(`uploads/transcode/${video.id}/${file}`)
        await s3.put(`uploads/${video.id}/${file}`, fileStream)
      }
    })

    // Then, clean up our tmp/ dir
    try {
      await fs.rmSync(Application.tmpPath(`uploads/transcode/${video.id}/`), { recursive: true })
    } catch (err) {
      Logger.error(err)
    }

    video.hlsPlaylist = `uploads/uploads/${video.id}/index.m3u8`

    await video.save()

    return new Promise((resolve) => {
      resolve()
    })
  }
}

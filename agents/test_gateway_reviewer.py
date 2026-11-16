import io
import json
import unittest
import gateway_reviewer

class GatewayTests(unittest.TestCase):
    def test_gateway_contract_and_credentials_are_not_in_model_input(self):
        result = dict(summary='Assistant and side video', session='Breadcrumb', labels=[dict(activity='AI conversation',role='focused',evidence='Assistant shown',confidence='high')],flags=['playback-unverified'])
        test = self
        class FakeOpener:
            def open(self, request, timeout):
                test.assertEqual(request.full_url, gateway_reviewer.ENDPOINT)
                test.assertEqual(request.get_header('Authorization'), 'Bearer gateway-key')
                data = json.loads(request.data)
                test.assertNotIn('lease-secret', request.data.decode())
                test.assertNotIn('private-participant', request.data.decode())
                test.assertEqual(data['model'], 'test/vision')
                test.assertEqual(data['messages'][1]['content'][1]['image_url']['url'], 'data:image/jpeg;base64,AQID')
                return io.BytesIO(json.dumps(dict(model='test/vision',choices=[dict(finish_reason='stop',message=dict(content=json.dumps(result)))])).encode())
        job = dict(lease='lease-secret', capture=dict(participant='private-participant', upload=dict(record=dict(app='Example'), payload=dict(jpeg='AQID', tree=[], screenText='Example'))))
        reviewed = gateway_reviewer.review(job, 'gateway-key', 'test/vision', FakeOpener())
        self.assertEqual(reviewed['version'], gateway_reviewer.VERSION)
        self.assertEqual(reviewed['summary'], result['summary'])

if __name__ == '__main__':
    unittest.main()

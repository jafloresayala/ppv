import pandas as pd
from data_service import sap_amount


def test_sap_amount_parses_negative_rate():
    assert sap_amount('6.79540-') == -6.7954
